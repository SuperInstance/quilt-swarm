/**
 * Shared test fixtures for quilt-swarm.
 *
 * These helpers produce in-memory Docker-shaped mocks so the engine can
 * be exercised without a real Docker daemon.
 */

import type { DockerodeLike } from '../src/swarm-adapter.js';

export interface FakeDockerState {
  swarms: { initialised: boolean; id: string };
  services: Map<string, { id: string; spec: Record<string, unknown> }>;
  tasks: Array<{ ID: string; ServiceID: string; Status: { State: string } }>;
  networks: Map<string, { id: string; driver: string; encrypted: boolean; subnet: string | null }>;
  secrets: Map<string, { id: string; name: string; data: string; labels: Record<string, string>; version: number }>;
  info: {
    Swarm?: { NodeID?: string; Managers?: number; Nodes?: number; ControlAvailable?: boolean };
  };
}

export function createFakeDocker(initial: Partial<FakeDockerState> = {}): { docker: DockerodeLike; state: FakeDockerState } {
  const state: FakeDockerState = {
    swarms: initial.swarms ?? { initialised: false, id: 'swarm-test-1' },
    services: initial.services ?? new Map(),
    tasks: initial.tasks ?? [],
    networks: initial.networks ?? new Map(),
    secrets: initial.secrets ?? new Map(),
    info: initial.info ?? { Swarm: { NodeID: 'node-1', Managers: 1, Nodes: 1, ControlAvailable: true } },
  };

  const swarmHandle = {
    init: async (spec: Record<string, unknown>) => {
      state.swarms.initialised = true;
      state.swarms.id = (spec['ID'] as string | undefined) ?? 'swarm-init';
    },
    join: async (_spec: Record<string, unknown>) => {
      state.swarms.initialised = true;
    },
    leave: async (_opts?: { force?: boolean }) => {
      state.swarms.initialised = false;
    },
    inspect: async () => {
      if (!state.swarms.initialised) return null;
      return { ID: state.swarms.id, Spec: { Name: 'default' } };
    },
  };

  const docker: DockerodeLike = {
    swarm: () => swarmHandle as unknown as ReturnType<NonNullable<DockerodeLike['swarm']>>,
    info: async () => state.info,
    getNode: (id: string) => ({
      inspect: async () => ({
        ID: id,
        Spec: { Role: 'manager', Availability: 'active' },
        ManagerStatus: { Leader: true },
      }),
    }),
    listServices: async (opts?: { filters?: string }) => {
      let services = Array.from(state.services.values());
      if (opts?.filters) {
        try {
          const parsed = JSON.parse(opts.filters) as { name?: string[] };
          if (parsed.name) {
            const names = new Set(parsed.name);
            services = services.filter((s) => names.has((s.spec as { Name?: string }).Name ?? ''));
          }
        } catch {
          // ignore filter parse errors
        }
      }
      return services.map((s) => {
        const spec = s.spec as {
          Name: string;
          TaskTemplate: { ContainerSpec: { Image: string } };
          Mode?: { Replicated?: { Replicas?: number } };
          EndpointSpec?: Record<string, unknown>;
          UpdateConfig?: Record<string, unknown>;
          Networks?: Array<{ Target: string }>;
        };
        return {
          ID: s.id,
          Spec: {
            Name: spec.Name,
            TaskTemplate: spec.TaskTemplate,
            Mode: spec.Mode,
            EndpointSpec: spec.EndpointSpec,
            UpdateConfig: spec.UpdateConfig,
            Networks: spec.Networks,
          },
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString(),
        };
      });
    },
    getService: (id: string) => {
      const found = Array.from(state.services.values()).find((s) => s.id === id);
      return {
        inspect: async () => {
          if (!found) throw new Error('not found');
          return {
            ID: found.id,
            Spec: found.spec as { Name: string; TaskTemplate: { ContainerSpec: { Image: string } }; Mode?: { Replicated?: { Replicas?: number } } },
          };
        },
        remove: async (_opts?: { force?: boolean }) => {
          state.services.delete(id);
          state.tasks = state.tasks.filter((t) => t.ServiceID !== id);
        },
        scale: async (opts: { Service: string; Version?: number }) => {
          if (!found) throw new Error('not found');
          const mode = (found.spec as { Mode?: { Replicated?: { Replicas?: number } } }).Mode;
          if (mode?.Replicated) {
            const requested = state.tasks.filter((t) => t.ServiceID === found.id).length;
            const desired = Number(opts.Service.split(':').pop() ?? requested);
            mode.Replicated.Replicas = desired;
          }
          return { Spec: found.spec as { Mode?: { Replicated?: { Replicas?: number } } } };
        },
      };
    },
    createService: async (spec: Record<string, unknown>) => {
      const id = `svc-${state.services.size + 1}`;
      state.services.set(id, { id, spec });
      return { id };
    },
    listTasks: async (_opts?: { filters?: string }) => state.tasks as never,
    getServiceLogs: async (_id: string, _opts?: Record<string, unknown>) => Buffer.from('test log line\n'),
    listNetworks: async (opts?: { filters?: string }) => {
      let nets = Array.from(state.networks.entries()).map(([id, n]) => ({
        Id: id,
        Name: n.id.replace(/^net-/, ''),
        Driver: n.driver,
        Encrypted: n.encrypted,
        IPAM: { Config: n.subnet ? [{ Subnet: n.subnet }] : [] },
      }));
      if (opts?.filters) {
        try {
          const parsed = JSON.parse(opts.filters) as { name?: string[] };
          if (parsed.name) {
            const names = new Set(parsed.name);
            nets = nets.filter((n) => names.has(n.Name));
          }
        } catch {
          // ignore
        }
      }
      return nets;
    },
    createNetwork: async (spec: Record<string, unknown>) => {
      const name = String((spec as { Name?: string }).Name ?? `net-${state.networks.size + 1}`);
      const id = `net-${state.networks.size + 1}`;
      const ipam = (spec as { IPAM?: { Config?: Array<{ Subnet?: string }> } }).IPAM;
      const subnet = ipam?.Config?.[0]?.Subnet ?? null;
      const encrypted = (spec as { Encrypted?: boolean }).Encrypted ?? false;
      state.networks.set(id, { id, driver: 'overlay', encrypted, subnet });
      return { id };
    },
    getNetwork: (id: string) => {
      const net = state.networks.get(id);
      return {
        inspect: async () => {
          if (!net) throw new Error('not found');
          return {
            Id: id,
            Name: net.id.replace(/^net-/, ''),
            Driver: net.driver,
            IPAM: { Config: net.subnet ? [{ Subnet: net.subnet }] : [] },
          };
        },
        remove: async (_opts?: { force?: boolean }) => {
          state.networks.delete(id);
        },
      };
    },
    listSecrets: async (opts?: { filters?: string }) => {
      let items = Array.from(state.secrets.values()).map((s) => ({
        ID: s.id,
        Spec: { Name: s.name, Labels: s.labels },
      }));
      if (opts?.filters) {
        try {
          const parsed = JSON.parse(opts.filters) as { label?: string[]; name?: string[] };
          if (parsed.name) {
            const names = new Set(parsed.name);
            items = items.filter((s) => names.has(s.Spec.Name));
          }
          if (parsed.label) {
            items = items.filter((s) => {
              const labels = s.Spec.Labels ?? {};
              return parsed.label!.every((kv) => {
                const [k, v] = kv.split('=');
                return k !== undefined && labels[k] === v;
              });
            });
          }
        } catch {
          // ignore
        }
      }
      return items;
    },
    createSecret: async (spec: Record<string, unknown>) => {
      const name = String((spec as { Name?: string }).Name ?? `secret-${state.secrets.size + 1}`);
      const id = `secret-${state.secrets.size + 1}`;
      const data = String((spec as { Data?: string }).Data ?? '');
      const labels = (spec as { Labels?: Record<string, string> }).Labels ?? {};
      state.secrets.set(id, { id, name, data, labels, version: 1 });
      return { id };
    },
    getSecret: (id: string) => {
      const secret = state.secrets.get(id);
      return {
        inspect: async () => {
          if (!secret) throw new Error('not found');
          return { ID: secret.id, Spec: { Name: secret.name, Labels: secret.labels } };
        },
        update: async (opts: { Version: number; Spec: Record<string, unknown> }) => {
          if (!secret) throw new Error('not found');
          secret.data = String((opts.Spec as { Data?: string }).Data ?? '');
          secret.labels = (opts.Spec as { Labels?: Record<string, string> }).Labels ?? secret.labels;
          secret.version += 1;
        },
        remove: async () => {
          state.secrets.delete(id);
        },
      };
    },
  };

  return { docker, state };
}
