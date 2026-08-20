/**
 * NetworkManager — creates and maintains Docker Swarm overlay networks
 * with encryption enabled by default.
 *
 * Quilt treats networks as first-class citizens (each `kind: 'network'`
 * cell in a sheet references a network). The manager guarantees:
 *   - Encrypted overlay by default (`Encrypted: true`).
 *   - Configurable subnet pool (defaults to a 10.128.0.0/16 range so
 *     multiple Swarm clusters can coexist in a single VPC).
 *   - Idempotent creation: calling `ensure` twice with the same name
 *     returns the existing network.
 */

import type Dockerode from 'dockerode';

export interface NetworkSpec {
  name: string;
  driver?: 'overlay' | 'bridge';
  attachable?: boolean;
  encrypted?: boolean;
  subnet?: string;
  gateway?: string;
  labels?: Record<string, string>;
}

export interface NetworkRecord {
  id: string;
  name: string;
  driver: string;
  encrypted: boolean;
  subnet: string | null;
  createdAt: string;
}

export interface DockerodeNetworkLike {
  listNetworks(opts?: { filters?: string }): Promise<Array<{ Id?: string; ID?: string; Name: string; Driver: string; IPAM?: { Config?: Array<{ Subnet?: string }> } }>>;
  createNetwork(spec: Record<string, unknown>): Promise<{ id: string }>;
  getNetwork(id: string): {
    inspect(): Promise<{ Id: string; Name: string; Driver: string; IPAM?: { Config?: Array<{ Subnet?: string }> } }>;
    remove(opts?: { force?: boolean }): Promise<void>;
  };
}

export interface NetworkManagerOptions {
  docker: DockerodeNetworkLike | Dockerode;
  /** Default subnet pool (CIDR). Default: 10.128.0.0/16. */
  defaultSubnet?: string;
  /** Force-encrypt every network (default true). */
  encryptedByDefault?: boolean;
}

const DEFAULT_SUBNET = '10.128.0.0/16';

export class NetworkManager {
  private readonly docker: DockerodeNetworkLike;
  private readonly defaultSubnet: string;
  private readonly encryptedByDefault: boolean;
  private readonly cache = new Map<string, NetworkRecord>();

  constructor(options: NetworkManagerOptions) {
    this.docker = options.docker as DockerodeNetworkLike;
    this.defaultSubnet = options.defaultSubnet ?? DEFAULT_SUBNET;
    this.encryptedByDefault = options.encryptedByDefault ?? true;
  }

  private buildCreateSpec(spec: NetworkSpec): Record<string, unknown> {
    const driver = spec.driver ?? 'overlay';
    const encrypted = spec.encrypted ?? this.encryptedByDefault;
    const subnet = spec.subnet ?? this.defaultSubnet;
    const ipamConfig: Array<{ Subnet: string; Gateway?: string }> = [{ Subnet: subnet }];
    if (spec.gateway) ipamConfig[0]!.Gateway = spec.gateway;
    return {
      Name: spec.name,
      Driver: driver,
      CheckDuplicate: true,
      Attachable: spec.attachable ?? true,
      Encrypted: encrypted,
      IPAM: { Driver: 'default', Config: ipamConfig },
      Labels: {
        'quilt.managed-by': 'quilt-swarm',
        'quilt.encrypted': String(encrypted),
        ...(spec.labels ?? {}),
      },
    };
  }

  /** Idempotently create a network. */
  async ensure(spec: NetworkSpec): Promise<NetworkRecord> {
    const existing = await this.findByName(spec.name);
    if (existing) {
      const record: NetworkRecord = {
        id: existing.id,
        name: spec.name,
        driver: existing.driver,
        encrypted: existing.encrypted,
        subnet: existing.subnet,
        createdAt: this.cache.get(spec.name)?.createdAt ?? new Date().toISOString(),
      };
      this.cache.set(spec.name, record);
      return record;
    }
    const created = await this.docker.createNetwork(this.buildCreateSpec(spec));
    const inspected = await this.docker.getNetwork(created.id).inspect();
    const record: NetworkRecord = {
      id: inspected.Id,
      name: inspected.Name,
      driver: inspected.Driver,
      encrypted: spec.encrypted ?? this.encryptedByDefault,
      subnet: inspected.IPAM?.Config?.[0]?.Subnet ?? spec.subnet ?? null,
      createdAt: new Date().toISOString(),
    };
    this.cache.set(spec.name, record);
    return record;
  }

  private async findByName(name: string): Promise<NetworkRecord | null> {
    const filters = JSON.stringify({ name: [name] });
    const list = await this.docker.listNetworks({ filters });
    const first = list[0];
    if (!first) return null;
    const id = first.Id ?? first.ID;
    if (!id) return null;
    const inspected = await this.docker.getNetwork(id).inspect();
    const encrypted = (first as { Encrypted?: boolean }).Encrypted ?? false;
    return {
      id,
      name: inspected.Name,
      driver: inspected.Driver,
      encrypted,
      subnet: inspected.IPAM?.Config?.[0]?.Subnet ?? null,
      createdAt: this.cache.get(name)?.createdAt ?? new Date().toISOString(),
    };
  }

  /** Remove a managed network. */
  async remove(name: string, force = false): Promise<void> {
    const existing = await this.findByName(name);
    if (!existing) return;
    await this.docker.getNetwork(existing.id).remove({ force });
    this.cache.delete(name);
  }

  /** List Quilt-managed networks. */
  async list(): Promise<NetworkRecord[]> {
    const filters = JSON.stringify({ label: ['quilt.managed-by=quilt-swarm'] });
    const items = await this.docker.listNetworks({ filters });
    const out: NetworkRecord[] = [];
    for (const item of items) {
      const id = item.Id ?? item.ID;
      if (!id) continue;
      const inspected = await this.docker.getNetwork(id).inspect();
      out.push({
        id,
        name: inspected.Name,
        driver: inspected.Driver,
        encrypted: (item as { Encrypted?: boolean }).Encrypted ?? false,
        subnet: inspected.IPAM?.Config?.[0]?.Subnet ?? null,
        createdAt: this.cache.get(inspected.Name)?.createdAt ?? new Date().toISOString(),
      });
    }
    return out;
  }

  /** Lookup a cached record. */
  get(name: string): NetworkRecord | undefined {
    return this.cache.get(name);
  }
}
