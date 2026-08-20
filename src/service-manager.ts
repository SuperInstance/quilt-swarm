/**
 * ServiceManager — translates Quilt cells into Docker Swarm services.
 *
 * Mapping rules (codified in `cellToServicePatch`):
 *
 *   | cell kind | Swarm artifact                              |
 *   |-----------|---------------------------------------------|
 *   | value     | environment variable on the target service |
 *   | formula   | sidecar that periodically refreshes the cell|
 *   | text      | label on the service                        |
 *   | image     | container image of the service              |
 *   | vault     | docker secret mounted at /run/secrets/...  |
 *   | network   | overlay network attachment                  |
 *
 * The manager is intentionally side-effect free: it only produces specs
 * and mutates a `Map<string, ServiceSpec>` cache. The SwarmAdapter
 * persists those specs to the Docker daemon.
 */

import type { ServiceSpec } from './types.js';
import type { CellKind, QuiltCell, QuiltRow, QuiltSheet } from './types.js';

export interface ServiceManagerOptions {
  /** Default service image used when a row has no explicit image cell. */
  defaultImage?: string;
  /** Default replica count. */
  defaultReplicas?: number;
  /** Network to attach every translated service to. */
  defaultNetwork?: string;
  /** Service name prefix (helps multi-tenant deployments). */
  namePrefix?: string;
}

const SIDE_CAR_IMAGE = 'ghcr.io/superinstance/quilt-cell-sidecar:0.1';

export class ServiceManager {
  private readonly opts: Required<ServiceManagerOptions>;
  private readonly services = new Map<string, ServiceSpec>();
  private readonly cellIndex = new Map<string, { row: number; cell: QuiltCell }>();

  constructor(options: ServiceManagerOptions = {}) {
    this.opts = {
      defaultImage: options.defaultImage ?? 'alpine:3.20',
      defaultReplicas: options.defaultReplicas ?? 1,
      defaultNetwork: options.defaultNetwork ?? 'quilt-overlay',
      namePrefix: options.namePrefix ?? 'quilt-',
    };
  }

  /** All services currently held in the manager. */
  list(): ServiceSpec[] {
    return Array.from(this.services.values());
  }

  /** Look up a single service by name. */
  get(name: string): ServiceSpec | undefined {
    return this.services.get(name);
  }

  /** Forget every cached service. */
  reset(): void {
    this.services.clear();
    this.cellIndex.clear();
  }

  /**
   * Translate a complete Quilt sheet into ServiceSpec records.
   * Each row in the sheet becomes one service; cells within the row
   * contribute to the spec via `cellToServicePatch`.
   */
  ingestSheet(sheet: QuiltSheet): ServiceSpec[] {
    const produced: ServiceSpec[] = [];
    for (let r = 0; r < sheet.rows.length; r += 1) {
      const row = sheet.rows[r];
      if (!row) continue;
      const svc = this.ingestRow(sheet.name, r, row);
      if (svc) produced.push(svc);
    }
    return produced;
  }

  /**
   * Translate a single row of a Quilt sheet into a ServiceSpec.
   * Exposed for direct use by the engine and tests.
   */
  ingestRow(sheetName: string, rowIndex: number, row: QuiltRow): ServiceSpec | null {
    // A row is "deployable" only if it has at least one image cell or a
    // service name. Pure documentation rows are skipped.
    const cells = Object.values(row);
    if (cells.length === 0) return null;

    const nameCell = cells.find((c) => c.ref.startsWith('A') && c.kind === 'text');
    const imageCell = cells.find((c) => c.kind === 'image');
    const name = (nameCell?.value ?? nameCell?.raw ?? `${sheetName}-row-${rowIndex}`)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-|-$/g, '');
    const serviceName = `${this.opts.namePrefix}${name}`;
    if (this.services.has(serviceName)) return this.services.get(serviceName)!;

    const spec: ServiceSpec = {
      name: serviceName,
      image: imageCell?.value ?? imageCell?.raw ?? this.opts.defaultImage,
      replicas: this.opts.defaultReplicas,
      env: {},
      labels: { 'quilt.sheet': sheetName, 'quilt.row': String(rowIndex) },
      networks: [this.opts.defaultNetwork],
      secrets: [],
      configs: [],
    };

    for (const cell of cells) {
      this.cellIndex.set(`${sheetName}.${cell.ref}`, { row: rowIndex, cell });
      this.cellToServicePatch(spec, cell);
    }
    this.services.set(serviceName, spec);
    return spec;
  }

  /**
   * Apply the contribution of a single cell to a service spec in-place.
   * This function is the heart of the cell→service mapping and is exported
   * via the class so tests can exercise it directly.
   */
  cellToServicePatch(spec: ServiceSpec, cell: QuiltCell): ServiceSpec {
    switch (cell.kind) {
      case 'value': {
        // VALUE cells: env vars. Use the row-relative ref (A,B,C…) as the
        // env key so multiple cells with the same value still materialise.
        const key = cell.ref.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
        const v = cell.value ?? cell.raw;
        spec.env![key] = v;
        spec.labels![`quilt.cell.${key}`] = 'value';
        return spec;
      }
      case 'formula': {
        // FORMULA cells: a sidecar that watches the cell and writes the
        // computed value into a shared config mounted at /etc/quilt/formula.
        spec.configs = spec.configs ?? [];
        const configName = `${spec.name}-${cell.ref.toLowerCase()}`;
        spec.configs.push(configName);
        spec.labels![`quilt.cell.${cell.ref}`] = `formula:${cell.value ?? cell.raw}`;
        return spec;
      }
      case 'text': {
        if (cell.ref === 'A1') {
          // already handled as service name; record as description label.
          spec.labels!['quilt.description'] = (cell.value ?? cell.raw).slice(0, 200);
        } else {
          spec.labels![`quilt.cell.${cell.ref}`] = 'text';
        }
        return spec;
      }
      case 'image': {
        spec.image = cell.value ?? cell.raw;
        spec.labels!['quilt.image.source'] = cell.ref;
        return spec;
      }
      case 'vault': {
        spec.secrets = spec.secrets ?? [];
        const secretName = (cell.value ?? cell.raw).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
        spec.secrets.push(secretName);
        spec.env![`${cell.ref.toUpperCase()}_VAULT_REF`] = secretName;
        return spec;
      }
      case 'network': {
        const networkName = cell.value ?? cell.raw;
        spec.networks = spec.networks ?? [];
        if (!spec.networks.includes(networkName)) spec.networks.push(networkName);
        spec.labels!['quilt.network.policy'] = cell.ref;
        return spec;
      }
    }
  }

  /**
   * Build the sidecar definition that refreshes a formula cell.
   * The Quilt runtime (quilt-fleet) consumes these specs to spawn
   * the actual refreshers.
   */
  buildFormulaSidecar(spec: ServiceSpec, cell: QuiltCell): ServiceSpec {
    return {
      name: `${spec.name}-${cell.ref.toLowerCase()}-sidecar`,
      image: SIDE_CAR_IMAGE,
      replicas: spec.replicas ?? 1,
      env: {
        QUILT_CELL: cell.ref,
        QUILT_TARGET_SERVICE: spec.name,
        QUILT_FORMULA: cell.value ?? cell.raw,
        ...(cell.ttlSeconds ? { QUILT_TTL_SECONDS: String(cell.ttlSeconds) } : {}),
      },
      labels: {
        'quilt.role': 'formula-sidecar',
        'quilt.parent': spec.name,
      },
      networks: spec.networks,
    };
  }

  /** Cell-kind enumeration (useful for callers that need to drive UIs). */
  kinds(): CellKind[] {
    return ['value', 'formula', 'text', 'image', 'vault', 'network'];
  }

  /** Lookup a previously indexed cell. */
  findCell(refKey: string): { row: number; cell: QuiltCell } | undefined {
    return this.cellIndex.get(refKey);
  }
}
