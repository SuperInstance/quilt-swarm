/**
 * Quilt-Swarm public surface.
 *
 * Importing this module gives you everything you need to drive a
 * Docker Swarm cluster from a Quilt sheet:
 *
 *   import { SwarmEngine, ServiceManager, SecretManager, NetworkManager, SwarmAdapter } from 'quilt-swarm';
 */

export { SwarmEngine } from './swarm-engine.js';
export type { SwarmEngineOptions, DeployResult } from './swarm-engine.js';

export { SwarmAdapter } from './swarm-adapter.js';
export type { DockerodeLike, SwarmAdapterOptions } from './swarm-adapter.js';
export { decodeLogStream } from './swarm-adapter.js';

export { ServiceManager } from './service-manager.js';
export type { ServiceManagerOptions } from './service-manager.js';

export { SecretManager } from './secret-manager.js';
export type {
  SecretManagerOptions,
  SecretRecord,
  VaultCellSpec,
  DockerodeSecretLike,
} from './secret-manager.js';

export { NetworkManager } from './network-manager.js';
export type {
  NetworkManagerOptions,
  NetworkRecord,
  NetworkSpec,
  DockerodeNetworkLike,
} from './network-manager.js';

export { QuiltSwarmCLI } from './cli.js';

export type {
  CellKind,
  CellRef,
  ClusterStatus,
  DeployOptions,
  EndpointSpec,
  InitOptions,
  JoinOptions,
  LogLine,
  LogsOptions,
  Mount,
  QuiltCell,
  QuiltRow,
  QuiltSheet,
  Resources,
  RestartPolicy,
  ScaleOptions,
  ServiceSpec,
  ServiceStatus,
  UpdateConfig,
} from './types.js';
