/**
 * SwarmAdapter — Thin wrapper around dockerode for Swarm operations.
 *
 * This is the *only* place that talks to the Docker daemon. Everything else
 * in quilt-swarm goes through this adapter so the rest of the codebase can be
 * tested without a live Docker socket. The adapter is intentionally
 * transport-agnostic: pass a dockerode instance (real or mock) at
 * construction time.
 */

import type Dockerode from 'dockerode';

import type {
  ClusterStatus,
  EndpointSpec,
  InitOptions,
  JoinOptions,
  LogLine,
  Resources,
  RestartPolicy,
  ServiceSpec,
  ServiceStatus,
  UpdateConfig,
} from './types.js';

/** Minimal dockerode surface we rely on. */
export interface DockerodeLike {
  swarm?: (opts?: Record<string, unknown>) => {
    init(opts: Record<string, unknown>): Promise<void>;
    join(opts: Record<string, unknown>): Promise<void>;
    leave(opts?: { force?: boolean }): Promise<void>;
    inspect(): Promise<{
      ID: string;
      Spec: { Name?: string };
    } | null>;
  };
  info(): Promise<{
    Swarm?: {
      NodeID?: string;
      Managers?: number;
      Nodes?: number;
      ControlAvailable?: boolean;
    };
  }>;
  getNode(id: string): {
    inspect(): Promise<{
      ID: string;
      Spec: { Role?: string; Availability?: string };
      ManagerStatus?: { Leader?: boolean };
    }>;
  };
  listServices(opts?: { filters?: string }): Promise<
    Array<{
      ID: string;
      Spec: {
        Name: string;
        TaskTemplate: {
          ContainerSpec: { Image: string };
          RestartPolicy?: RestartPolicy;
          Resources?: Resources;
        };
        Mode?: { Replicated?: { Replicas?: number } };
        EndpointSpec?: EndpointSpec;
        UpdateConfig?: UpdateConfig;
        Networks?: Array<{ Target: string }>;
      };
      UpdatedAt?: string;
      CreatedAt?: string;
    }>
  >;
  getService(id: string): {
    inspect(): Promise<{
      ID: string;
      Spec: {
        Name: string;
        TaskTemplate: { ContainerSpec: { Image: string } };
        Mode?: { Replicated?: { Replicas?: number } };
      };
    }>;
    remove(opts?: { force?: boolean }): Promise<void>;
    scale(opts: { Service: string; Version?: number }): Promise<{
      Spec: { Mode?: { Replicated?: { Replicas?: number } } };
    }>;
  };
  createService(spec: Record<string, unknown>): Promise<{ id: string }>;
  listTasks(opts?: { filters?: string }): Promise<
    Array<{
      ID: string;
      ServiceID: string;
      NodeID: string;
      Status?: { State?: string; Timestamp?: string };
      DesiredState?: string;
    }>
  >;
  getServiceLogs?(id: string, opts?: Record<string, unknown>): Promise<NodeJS.ReadableStream | Buffer | string>;
  listNetworks(opts?: { filters?: string }): Promise<unknown[]>;
  createNetwork?(spec: Record<string, unknown>): Promise<{ id: string }>;
  getNetwork?(id: string): { remove(opts?: { force?: boolean }): Promise<void> };
  listSecrets?(opts?: { filters?: string }): Promise<unknown[]>;
  createSecret?(spec: Record<string, unknown>): Promise<{ id: string }>;
  getSecret?(id: string): { remove(): Promise<void> };
}

/** Options accepted by the adapter constructor. */
export interface SwarmAdapterOptions {
  docker: DockerodeLike | Dockerode;
  /** Pre-existing swarm accessor (overrides `docker.swarm()`). Useful for tests. */
  swarmHandle?: DockerodeLike['swarm'] extends () => infer T ? T : never;
}

interface InternalSwarmHandle {
  init(opts: Record<string, unknown>): Promise<void>;
  join(opts: Record<string, unknown>): Promise<void>;
  leave(opts?: { force?: boolean }): Promise<void>;
  inspect(): Promise<{ ID: string; Spec: { Name?: string } } | null>;
}

export class SwarmAdapter {
  private readonly docker: DockerodeLike;
  private readonly swarmHandle: InternalSwarmHandle | undefined;

  constructor(options: SwarmAdapterOptions) {
    this.docker = options.docker as DockerodeLike;
    this.swarmHandle = options.swarmHandle as InternalSwarmHandle | undefined;
  }

  /** Return the raw dockerode handle (for advanced users / tests). */
  raw(): DockerodeLike {
    return this.docker;
  }

  private swarm(): InternalSwarmHandle {
    if (this.swarmHandle) return this.swarmHandle;
    if (!this.docker.swarm) {
      throw new Error('Underlying docker client does not expose swarm()');
    }
    return this.docker.swarm() as unknown as InternalSwarmHandle;
  }

  // ────────────────────────────────────────────────────────────
  // Cluster lifecycle
  // ────────────────────────────────────────────────────────────

  async initSwarm(opts: InitOptions): Promise<{ swarmId: string }> {
    const swarm = this.swarm();
    const swarmSpec = {
      Name: 'default',
      ListenAddr: opts.listenAddr ?? '0.0.0.0:2377',
      AdvertiseAddr: opts.advertiseAddr,
      DataPathAddr: opts.dataPathAddr ?? opts.advertiseAddr,
      DefaultAddrPool: opts.defaultAddrPool,
      SubnetSize: opts.subnetSize,
      ForceNewCluster: opts.forceNewCluster,
      Availability: opts.availability ?? 'active',
    } as Record<string, unknown>;
    // Strip undefined keys so we don't override dockerode defaults.
    for (const k of Object.keys(swarmSpec)) {
      if (swarmSpec[k] === undefined) delete swarmSpec[k];
    }
    await swarm.init(swarmSpec);
    const inspected = await swarm.inspect();
    return { swarmId: inspected?.ID ?? 'unknown' };
  }

  async joinSwarm(opts: JoinOptions): Promise<void> {
    const swarm = this.swarm();
    const joinSpec: Record<string, unknown> = {
      JoinToken: opts.joinToken,
      RemoteAddrs: opts.remoteAddrs,
      ListenAddr: opts.listenAddr,
      AdvertiseAddr: opts.advertiseAddr,
      DataPathAddr: opts.dataPathAddr,
    };
    for (const k of Object.keys(joinSpec)) {
      if (joinSpec[k] === undefined) delete joinSpec[k];
    }
    await swarm.join(joinSpec);
  }

  async leaveSwarm(force = false): Promise<void> {
    const swarm = this.swarm();
    await swarm.leave({ force });
  }

  async inspectSwarm(): Promise<{ id: string; name: string } | null> {
    const swarm = this.swarm();
    const result = await swarm.inspect();
    if (!result) return null;
    return { id: result.ID, name: result.Spec.Name ?? 'default' };
  }

  // ────────────────────────────────────────────────────────────
  // Cluster status
  // ────────────────────────────────────────────────────────────

  async getClusterStatus(): Promise<ClusterStatus> {
    const [info, swarm, services] = await Promise.all([
      this.docker.info(),
      this.swarm().inspect().catch(() => null),
      this.docker.listServices({}),
    ]);
    const nodeId = info.Swarm?.NodeID ?? null;
    let isManager = false;
    if (nodeId) {
      try {
        const node = await this.docker.getNode(nodeId).inspect();
        isManager = node.Spec.Role === 'manager';
      } catch {
        // node inspect failed; treat as worker
        isManager = false;
      }
    }
    const tasks = await this.docker.listTasks({}).catch(() => []);
    const taskCountByService = new Map<string, { running: number; total: number }>();
    for (const task of tasks) {
      const sid = task.ServiceID;
      if (!sid) continue;
      const bucket = taskCountByService.get(sid) ?? { running: 0, total: 0 };
      bucket.total += 1;
      if (task.Status?.State === 'running') bucket.running += 1;
      taskCountByService.set(sid, bucket);
    }
    const serviceStatuses: ServiceStatus[] = services.map((svc) => {
      const counts = taskCountByService.get(svc.ID) ?? { running: 0, total: 0 };
      const replicas = svc.Spec.Mode?.Replicated?.Replicas ?? 1;
      return {
        name: svc.Spec.Name,
        image: svc.Spec.TaskTemplate.ContainerSpec.Image,
        replicas,
        running: counts.running,
        desired: replicas,
        state: counts.running > 0 ? 'running' : counts.total > 0 ? 'pending' : 'unknown',
        updatedAt: svc.UpdatedAt ?? svc.CreatedAt ?? new Date().toISOString(),
      };
    });
    return {
      swarmId: swarm?.ID ?? null,
      nodeId,
      isManager,
      managers: info.Swarm?.Managers ?? 0,
      workers: Math.max((info.Swarm?.Nodes ?? 0) - (info.Swarm?.Managers ?? 0), 0),
      services: serviceStatuses,
    };
  }

  // ────────────────────────────────────────────────────────────
  // Services
  // ────────────────────────────────────────────────────────────

  /** Build a dockerode-compatible TaskSpec from a Quilt ServiceSpec. */
  buildServiceSpec(spec: ServiceSpec): Record<string, unknown> {
    const containerSpec: Record<string, unknown> = {
      Image: spec.image,
      Env: spec.env ? Object.entries(spec.env).map(([k, v]) => `${k}=${v}`) : undefined,
      Labels: spec.labels,
      Command: spec.command,
      Args: spec.args,
      Mounts: spec.mounts?.map((m) => ({
        Target: m.target,
        Source: m.source,
        ReadOnly: m.readOnly ?? true,
        Type: 'bind',
      })),
      Secrets: spec.secrets?.map((s) => ({
        File: { Name: `/run/secrets/${s}`, Mode: 0o400, UID: '0', GID: '0' },
        SecretID: s,
        SecretName: s,
      })),
      Configs: spec.configs?.map((c) => ({
        File: { Name: `/etc/quilt/${c}`, Mode: 0o444, UID: '0', GID: '0' },
        ConfigID: c,
        ConfigName: c,
      })),
    };
    for (const k of Object.keys(containerSpec)) {
      if (containerSpec[k] === undefined) delete containerSpec[k];
    }
    const taskTemplate = {
      ContainerSpec: containerSpec,
      RestartPolicy: spec.restart,
      Resources: spec.resources,
      Networks: spec.networks?.map((n) => ({ Target: n })),
    };
    for (const k of Object.keys(taskTemplate)) {
      if ((taskTemplate as Record<string, unknown>)[k] === undefined) {
        delete (taskTemplate as Record<string, unknown>)[k];
      }
    }
    const mode = { Replicated: { Replicas: spec.replicas ?? 1 } };
    return {
      Name: spec.name,
      TaskTemplate: taskTemplate,
      Mode: mode,
      EndpointSpec: spec.endpointSpec,
      UpdateConfig: spec.update,
      Networks: spec.networks?.map((n) => ({ Target: n })),
    };
  }

  async createService(spec: ServiceSpec): Promise<{ id: string }> {
    const swarmSpec = this.buildServiceSpec(spec);
    swarmSpec.Name = spec.name;
    const result = await this.docker.createService(swarmSpec);
    return { id: (result as { id: string }).id };
  }

  async listServices(): Promise<ServiceStatus[]> {
    const services = await this.docker.listServices({});
    const tasks = await this.docker.listTasks({}).catch(() => []);
    const running = new Map<string, number>();
    for (const t of tasks) {
      if (!t.ServiceID) continue;
      if (t.Status?.State === 'running') {
        running.set(t.ServiceID, (running.get(t.ServiceID) ?? 0) + 1);
      }
    }
    return services.map((svc) => {
      const replicas = svc.Spec.Mode?.Replicated?.Replicas ?? 1;
      return {
        name: svc.Spec.Name,
        image: svc.Spec.TaskTemplate.ContainerSpec.Image,
        replicas,
        running: running.get(svc.ID) ?? 0,
        desired: replicas,
        state: (running.get(svc.ID) ?? 0) > 0 ? 'running' : 'pending',
        updatedAt: svc.UpdatedAt ?? svc.CreatedAt ?? new Date().toISOString(),
      };
    });
  }

  async scaleService(service: string, replicas: number): Promise<{ replicas: number }> {
    const services = await this.docker.listServices({ filters: JSON.stringify({ name: [service] }) });
    const target = services[0];
    if (!target) throw new Error(`Service not found: ${service}`);
    const svcHandle = this.docker.getService(target.ID);
    const version = await svcHandle.inspect().catch(() => undefined as unknown);
    void version;
    await svcHandle.scale({ Service: service, Version: 0 } as { Service: string; Version?: number });
    return { replicas };
  }

  async removeService(service: string, force = false): Promise<void> {
    const services = await this.docker.listServices({ filters: JSON.stringify({ name: [service] }) });
    const target = services[0];
    if (!target) return;
    const svcHandle = this.docker.getService(target.ID);
    await svcHandle.remove({ force });
  }

  // ────────────────────────────────────────────────────────────
  // Logs
  // ────────────────────────────────────────────────────────────

  async fetchLogs(
    service: string,
    opts: { tail?: number | 'all'; since?: number; timestamps?: boolean; stdout?: boolean; stderr?: boolean } = {},
  ): Promise<LogLine[]> {
    const services = await this.docker.listServices({ filters: JSON.stringify({ name: [service] }) });
    const target = services[0];
    if (!target) throw new Error(`Service not found: ${service}`);
    if (!this.docker.getServiceLogs) {
      // No log fetch capability — return an empty stream to keep callers safe.
      return [];
    }
    const stream = await this.docker.getServiceLogs(target.ID, {
      stdout: opts.stdout ?? true,
      stderr: opts.stderr ?? true,
      timestamps: opts.timestamps ?? true,
      tail: opts.tail ?? 'all',
      since: opts.since ?? 0,
      follow: false,
    });
    return decodeLogStream(service, stream);
  }
}

/**
 * Decode a dockerode log stream into structured LogLine records.
 * Exported for reuse by the CLI and tests; tolerant of Buffer | string.
 */
export async function decodeLogStream(
  service: string,
  stream: NodeJS.ReadableStream | Buffer | string | null | undefined,
): Promise<LogLine[]> {
  if (stream == null) return [];
  let raw: string;
  if (typeof stream === 'string') raw = stream;
  else if (Buffer.isBuffer(stream)) raw = stream.toString('utf-8');
  else {
    raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
  }
  // Docker multiplexed framing: [stream(1)][0 0 0][size(4)][payload]
  const out: LogLine[] = [];
  let offset = 0;
  let frameIdx = 0;
  while (offset < raw.length) {
    // Attempt to read the 8-byte header.
    if (offset + 8 > raw.length) {
      out.push({
        service,
        task: `${service}.${frameIdx}`,
        timestamp: new Date().toISOString(),
        stream: 'stdout',
        message: raw.slice(offset),
      });
      break;
    }
    const streamType = raw.charCodeAt(offset);
    const size = raw.readUInt32BE ? (raw as unknown as Buffer).readUInt32BE(offset + 4) : 0;
    if (size === 0 || size > raw.length - offset - 8) {
      // Not a framed payload — treat the rest as a single line.
      out.push({
        service,
        task: `${service}.${frameIdx++}`,
        timestamp: new Date().toISOString(),
        stream: 'stdout',
        message: raw.slice(offset + 8),
      });
      break;
    }
    const payload = raw.slice(offset + 8, offset + 8 + size);
    out.push({
      service,
      task: `${service}.${frameIdx++}`,
      timestamp: new Date().toISOString(),
      stream: streamType === 2 ? 'stderr' : 'stdout',
      message: payload,
    });
    offset += 8 + size;
  }
  return out;
}
