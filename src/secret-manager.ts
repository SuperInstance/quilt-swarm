/**
 * SecretManager — orchestrates Docker secrets from Quilt vault cells.
 *
 * Quilt vault cells (`kind: 'vault'`) are mapped to Docker secrets that
 * are mounted at /run/secrets/<name> inside the service containers.
 * The manager keeps a local cache of the spec→secret id mapping so that
 * rotation only needs to swap the data of an existing secret (preserving
 * the immutable secret ID) rather than recreating the service.
 */

import type Dockerode from 'dockerode';

export interface VaultCellSpec {
  ref: string;
  name: string;
  data: string | Buffer;
  labels?: Record<string, string>;
}

export interface SecretRecord {
  id: string;
  name: string;
  version: string;
  createdAt: string;
  rotatedAt: string | null;
  labels: Record<string, string>;
}

export interface DockerodeSecretLike {
  listSecrets(opts?: { filters?: string }): Promise<Array<{ ID: string; Spec: { Name: string; Labels?: Record<string, string> } }>>;
  createSecret(spec: Record<string, unknown>): Promise<{ id: string }>;
  getSecret(id: string): {
    inspect(): Promise<{ ID: string; Spec: { Name: string; Labels?: Record<string, string> } }>;
    update(opts: { Version: number; Spec: Record<string, unknown> }): Promise<void>;
    remove(): Promise<void>;
  };
}

export interface SecretManagerOptions {
  docker: DockerodeSecretLike | Dockerode;
  /** Namespace prepended to every secret name (default: `quilt_`). */
  namespace?: string;
}

export class SecretManager {
  private readonly docker: DockerodeSecretLike;
  private readonly namespace: string;
  private readonly cache = new Map<string, SecretRecord>();

  constructor(options: SecretManagerOptions) {
    this.docker = options.docker as DockerodeSecretLike;
    this.namespace = options.namespace ?? 'quilt_';
  }

  /** Resolve the on-disk secret name for a vault cell. */
  private resolveName(spec: VaultCellSpec): string {
    return `${this.namespace}${spec.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_')}`;
  }

  private async findByName(name: string): Promise<{ id: string; version: number } | null> {
    const filters = JSON.stringify({ name: [name] });
    const list = await this.docker.listSecrets({ filters });
    if (list.length === 0) return null;
    const first = list[0];
    if (!first) return null;
    const inspected = await this.docker.getSecret(first.ID).inspect();
    // dockerode does not surface a numeric version on inspect; we keep the
    // local cache as the source of truth and return 0 here.
    void inspected;
    return { id: first.ID, version: 0 };
  }

  /** Create or update a secret from a vault cell. */
  async upsert(spec: VaultCellSpec): Promise<SecretRecord> {
    const name = this.resolveName(spec);
    const dataBuffer = typeof spec.data === 'string' ? Buffer.from(spec.data, 'utf-8') : spec.data;
    const existing = await this.findByName(name);
    const labels = {
      'quilt.cell': spec.ref,
      'quilt.managed-by': 'quilt-swarm',
      ...(spec.labels ?? {}),
    };
    if (existing) {
      const handle = this.docker.getSecret(existing.id);
      const inspected = await handle.inspect();
      await handle.update({
        Version: 0,
        Spec: {
          Name: name,
          Data: dataBuffer.toString('base64'),
          Labels: { ...inspected.Spec.Labels, ...labels },
        },
      });
      const record: SecretRecord = {
        id: existing.id,
        name,
        version: bumpVersion(this.cache.get(name)?.version),
        createdAt: this.cache.get(name)?.createdAt ?? new Date().toISOString(),
        rotatedAt: new Date().toISOString(),
        labels,
      };
      this.cache.set(name, record);
      return record;
    }
    const created = await this.docker.createSecret({
      Name: name,
      Data: dataBuffer.toString('base64'),
      Labels: labels,
      Driver: { Name: 'secret-driver' },
    });
    const record: SecretRecord = {
      id: created.id,
      name,
      version: '1',
      createdAt: new Date().toISOString(),
      rotatedAt: null,
      labels,
    };
    this.cache.set(name, record);
    return record;
  }

  /** Rotate an existing secret in-place. */
  async rotate(name: string, newData: string | Buffer): Promise<SecretRecord> {
    const dataBuffer = typeof newData === 'string' ? Buffer.from(newData, 'utf-8') : newData;
    const existing = await this.findByName(name);
    if (!existing) throw new Error(`Cannot rotate unknown secret: ${name}`);
    const handle = this.docker.getSecret(existing.id);
    const inspected = await handle.inspect();
    await handle.update({
      Version: 0,
      Spec: {
        Name: name,
        Data: dataBuffer.toString('base64'),
        Labels: inspected.Spec.Labels,
      },
    });
    const prev = this.cache.get(name);
    const record: SecretRecord = {
      id: existing.id,
      name,
      version: bumpVersion(prev?.version),
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      rotatedAt: new Date().toISOString(),
      labels: inspected.Spec.Labels ?? {},
    };
    this.cache.set(name, record);
    return record;
  }

  /** Remove a managed secret. */
  async remove(name: string): Promise<void> {
    const existing = await this.findByName(name);
    if (!existing) return;
    await this.docker.getSecret(existing.id).remove();
    this.cache.delete(name);
  }

  /** List all managed secrets (those created by this manager). */
  async list(): Promise<SecretRecord[]> {
    const filters = JSON.stringify({ label: ['quilt.managed-by=quilt-swarm'] });
    const items = await this.docker.listSecrets({ filters });
    const out: SecretRecord[] = [];
    for (const item of items) {
      const inspected = await this.docker.getSecret(item.ID).inspect();
      out.push({
        id: item.ID,
        name: item.Spec.Name,
        version: this.cache.get(item.Spec.Name)?.version ?? '1',
        createdAt: this.cache.get(item.Spec.Name)?.createdAt ?? new Date().toISOString(),
        rotatedAt: this.cache.get(item.Spec.Name)?.rotatedAt ?? null,
        labels: item.Spec.Labels ?? {},
      });
      void inspected;
    }
    return out;
  }

  /** Lookup a cached record. */
  get(name: string): SecretRecord | undefined {
    return this.cache.get(name);
  }

  /** Forget every cached record (does not touch the Docker daemon). */
  clear(): void {
    this.cache.clear();
  }
}

function bumpVersion(prev: string | undefined): string {
  if (!prev) return '1';
  const n = Number.parseInt(prev, 10);
  if (Number.isNaN(n)) return '1';
  return String(n + 1);
}
