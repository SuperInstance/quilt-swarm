/**
 * SwarmEngine — the high-level orchestrator that the CLI and external
 * integrations call. It owns a SwarmAdapter, a ServiceManager, a
 * SecretManager, and a NetworkManager and stitches them together.
 *
 * Design goals:
 *   - One `SwarmEngine` instance per cluster connection.
 *   - Stateful: it remembers which services and secrets it created so it
 *     can update them in place when a sheet is re-ingested.
 *   - Defensive: every public method returns a Promise; failures bubble
 *     up as rejected promises (no silent `try { } catch {}`).
 */

import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';

import { NetworkManager, type NetworkManagerOptions } from './network-manager.js';
import { SecretManager, type SecretManagerOptions } from './secret-manager.js';
import { ServiceManager, type ServiceManagerOptions } from './service-manager.js';
import { SwarmAdapter, type DockerodeLike, type SwarmAdapterOptions } from './swarm-adapter.js';
import type {
  ClusterStatus,
  DeployOptions,
  InitOptions,
  JoinOptions,
  LogLine,
  QuiltCell,
  QuiltRow,
  QuiltSheet,
  ScaleOptions,
  ServiceSpec,
  ServiceStatus,
} from './types.js';

export interface SwarmEngineOptions {
  docker: DockerodeLike;
  swarmHandle?: SwarmAdapterOptions['swarmHandle'];
  serviceManager?: ServiceManagerOptions;
  secretManager?: SecretManagerOptions;
  networkManager?: NetworkManagerOptions;
}

export interface DeployResult {
  service: string;
  replicas: number;
  image: string;
}

export class SwarmEngine {
  readonly adapter: SwarmAdapter;
  readonly services: ServiceManager;
  readonly secrets: SecretManager;
  readonly networks: NetworkManager;

  constructor(opts: SwarmEngineOptions) {
    this.adapter = new SwarmAdapter({ docker: opts.docker, swarmHandle: opts.swarmHandle });
    this.services = new ServiceManager(opts.serviceManager);
    this.secrets = new SecretManager({ docker: opts.docker, ...(opts.secretManager ?? {}) });
    this.networks = new NetworkManager({ docker: opts.docker, ...(opts.networkManager ?? {}) });
  }

  // ────────────────────────────────────────────────────────────
  // Cluster lifecycle
  // ────────────────────────────────────────────────────────────

  init(opts: InitOptions): Promise<{ swarmId: string }> {
    return this.adapter.initSwarm(opts);
  }

  join(opts: JoinOptions): Promise<void> {
    return this.adapter.joinSwarm(opts);
  }

  leave(force = false): Promise<void> {
    return this.adapter.leaveSwarm(force);
  }

  inspect(): Promise<{ id: string; name: string } | null> {
    return this.adapter.inspectSwarm();
  }

  status(): Promise<ClusterStatus> {
    return this.adapter.getClusterStatus();
  }

  // ────────────────────────────────────────────────────────────
  // Sheet ingestion
  // ────────────────────────────────────────────────────────────

  /**
   * Load a Quilt sheet from a YAML file on disk.
   * The expected format is documented in `examples/deploy-stack.yml`.
   */
  async loadSheet(path: string): Promise<QuiltSheet> {
    const raw = await readFile(path, 'utf-8');
    return this.parseSheet(raw);
  }

  /** Parse a YAML string into a QuiltSheet. */
  parseSheet(raw: string): QuiltSheet {
    const doc = parseYaml(raw) as { name?: string; rows?: Array<Record<string, string>> } | null;
    if (!doc || typeof doc !== 'object') {
      throw new Error('Invalid Quilt sheet: top-level must be an object');
    }
    const name = doc.name ?? 'quilt-sheet';
    const rows: QuiltRow[] = (doc.rows ?? []).map((r) => {
      const cells: QuiltRow = {};
      for (const [ref, raw] of Object.entries(r)) {
        const cell = this.parseCell(ref, raw);
        cells[ref] = cell;
      }
      return cells;
    });
    const cells: QuiltCell[] = rows.flatMap((r) => Object.values(r));
    return { name, rows, cells };
  }

  private parseCell(ref: string, raw: string): QuiltCell {
    const trimmed = String(raw).trim();
    if (trimmed.startsWith('=')) {
      return { ref, kind: 'formula', raw: trimmed, value: trimmed.slice(1) };
    }
    if (trimmed.startsWith('!vault ')) {
      return { ref, kind: 'vault', raw: trimmed, value: trimmed.slice(7).trim() };
    }
    if (trimmed.startsWith('!net ')) {
      return { ref, kind: 'network', raw: trimmed, value: trimmed.slice(5).trim() };
    }
    if (ref.toLowerCase() === 'image' || /^[a-z0-9./_-]+:[a-z0-9._-]+$/i.test(trimmed)) {
      return { ref, kind: 'image', raw: trimmed, value: trimmed };
    }
    if (trimmed.length === 0) {
      return { ref, kind: 'text', raw: trimmed };
    }
    if (/^(true|false|\d+(\.\d+)?)$/i.test(trimmed)) {
      return { ref, kind: 'value', raw: trimmed, value: trimmed };
    }
    return { ref, kind: 'text', raw: trimmed, value: trimmed };
  }

  // ────────────────────────────────────────────────────────────
  // Service deployment
  // ────────────────────────────────────────────────────────────

  async deploy(opts: DeployOptions): Promise<DeployResult> {
    if (opts.service) {
      return this.deployServiceSpec(opts.service);
    }
    if (opts.sheet) {
      return this.deployFromSheet(opts.sheet);
    }
    if (opts.sheetPath) {
      const sheet = await this.loadSheet(opts.sheetPath);
      return this.deployFromSheet(sheet);
    }
    if (opts.image) {
      const name = opts.name ?? `quilt-${Date.now()}`;
      return this.deployServiceSpec({
        name,
        image: opts.image,
        replicas: opts.replicas ?? 1,
      });
    }
    throw new Error('deploy() requires one of: service, sheet, sheetPath, image');
  }

  private async deployServiceSpec(spec: ServiceSpec): Promise<DeployResult> {
    // Ensure referenced networks exist.
    for (const n of spec.networks ?? []) {
      await this.networks.ensure({ name: n });
    }
    // Ensure referenced secrets exist (create empty placeholder if missing).
    for (const s of spec.secrets ?? []) {
      if (!this.secrets.get(s)) {
        await this.secrets.upsert({ ref: s, name: s, data: '' });
      }
    }
    const created = await this.adapter.createService(spec);
    return { service: spec.name, replicas: spec.replicas ?? 1, image: spec.image };
    void created;
  }

  private async deployFromSheet(sheet: QuiltSheet): Promise<DeployResult> {
    const specs = this.services.ingestSheet(sheet);
    if (specs.length === 0) {
      throw new Error('Sheet produced no deployable services');
    }
    // Materialise all referenced networks.
    const networkNames = new Set<string>();
    for (const svc of specs) {
      for (const n of svc.networks ?? []) networkNames.add(n);
    }
    for (const n of networkNames) {
      await this.networks.ensure({ name: n });
    }
    // Materialise all referenced secrets from vault cells.
    for (const cell of sheet.cells) {
      if (cell.kind === 'vault') {
        const name = (cell.value ?? cell.raw).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
        await this.secrets.upsert({ ref: cell.ref, name, data: '' });
      }
    }
    let last: DeployResult | null = null;
    for (const svc of specs) {
      // eslint-disable-next-line no-await-in-loop
      last = await this.deployServiceSpec(svc);
    }
    return last!;
  }

  // ────────────────────────────────────────────────────────────
  // Service management
  // ────────────────────────────────────────────────────────────

  scale(opts: ScaleOptions): Promise<{ replicas: number }> {
    return this.adapter.scaleService(opts.service, opts.replicas);
  }

  rm(service: string, force = false): Promise<void> {
    return this.adapter.removeService(service, force);
  }

  ps(): Promise<ServiceStatus[]> {
    return this.adapter.listServices();
  }

  logs(service: string, opts: { tail?: number | 'all'; since?: number; timestamps?: boolean } = {}): Promise<LogLine[]> {
    return this.adapter.fetchLogs(service, opts);
  }

  // ────────────────────────────────────────────────────────────
  // Secrets
  // ────────────────────────────────────────────────────────────

  upsertSecret(name: string, data: string | Buffer): Promise<{ id: string; name: string }> {
    return this.secrets.upsert({ ref: name, name, data }).then((r) => ({ id: r.id, name: r.name }));
  }

  rotateSecret(name: string, newData: string | Buffer) {
    return this.secrets.rotate(name, newData);
  }

  // ────────────────────────────────────────────────────────────
  // Networks
  // ────────────────────────────────────────────────────────────

  ensureNetwork(name: string) {
    return this.networks.ensure({ name });
  }
}
