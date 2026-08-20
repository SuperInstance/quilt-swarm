/**
 * Quilt-Swarm Type Definitions
 *
 * Shared types describing the bridge between Quilt sheets and Docker Swarm
 * services. These types intentionally mirror the shape of Docker's SwarmKit
 * primitives while adding the Quilt-specific annotations (cell references,
 * vault ids, network policies) that survive the translation.
 */

/** A Quilt cell reference, e.g. `A1`, `B12`, or a named range. */
export type CellRef = string;

/** Logical kind of a Quilt cell, used to drive Swarm translation. */
export type CellKind =
  | 'value' // scalar config / env var
  | 'formula' // derived value (materialised as a sidecar that refreshes the cell)
  | 'text' // free-form documentation / labels
  | 'image' // container image reference
  | 'vault' // secret reference
  | 'network'; // overlay network policy

/** A single cell extracted from a Quilt sheet. */
export interface QuiltCell {
  ref: CellRef;
  kind: CellKind;
  raw: string;
  value?: string;
  dependsOn?: CellRef[];
  ttlSeconds?: number;
}

/** A row in a Quilt sheet, keyed by cell ref. */
export interface QuiltRow {
  [ref: string]: QuiltCell;
}

/** The complete materialised view of a Quilt sheet. */
export interface QuiltSheet {
  name: string;
  rows: QuiltRow[];
  cells: QuiltCell[];
}

/** Mount target for a config or secret. */
export interface Mount {
  target: string;
  source?: string;
  readOnly?: boolean;
}

/** Endpoint exposed by a Swarm service. */
export interface EndpointSpec {
  mode: 'vip' | 'dnsrr';
  ports?: Array<{
    name?: string;
    protocol?: 'tcp' | 'udp' | 'sctp';
    targetPort: number;
    publishedPort?: number;
    publishMode?: 'ingress' | 'host';
  }>;
}

/** Resource limits applied to a Swarm service task. */
export interface Resources {
  limits?: { cpus?: string; memoryBytes?: number };
  reservations?: { cpus?: string; memoryBytes?: number };
}

/** Restart policy for a service. */
export interface RestartPolicy {
  condition?: 'none' | 'on-failure' | 'any';
  delay?: number;
  maxAttempts?: number;
  window?: number;
}

/** Update policy for rolling changes. */
export interface UpdateConfig {
  parallelism?: number;
  delay?: number;
  failureAction?: 'pause' | 'continue' | 'rollback';
  monitor?: number;
  maxFailureRatio?: number;
  order?: 'stop-first' | 'start-first';
}

/** Description of a Swarm service as Quilt sees it. */
export interface ServiceSpec {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: Record<string, string>;
  labels?: Record<string, string>;
  mounts?: Mount[];
  replicas?: number;
  endpointSpec?: EndpointSpec;
  resources?: Resources;
  restart?: RestartPolicy;
  update?: UpdateConfig;
  networks?: string[];
  secrets?: string[];
  configs?: string[];
  sourceCell?: CellRef;
}

/** Status of a single Swarm service. */
export interface ServiceStatus {
  name: string;
  image: string;
  replicas: number;
  running: number;
  desired: number;
  state: 'running' | 'paused' | 'failed' | 'pending' | 'unknown';
  updatedAt: string;
}

/** A log line returned by the engine. */
export interface LogLine {
  service: string;
  task: string;
  timestamp: string;
  stream: 'stdout' | 'stderr';
  message: string;
}

/** Cluster-wide status snapshot. */
export interface ClusterStatus {
  swarmId: string | null;
  nodeId: string | null;
  isManager: boolean;
  managers: number;
  workers: number;
  services: ServiceStatus[];
}

/** Options accepted by `SwarmEngine.init`. */
export interface InitOptions {
  listenAddr?: string;
  advertiseAddr: string;
  dataPathAddr?: string;
  defaultAddrPool?: string[];
  subnetSize?: number;
  forceNewCluster?: boolean;
  availability?: 'active' | 'drain' | 'pause';
}

/** Options accepted by `SwarmEngine.join`. */
export interface JoinOptions {
  joinToken: string;
  remoteAddrs: string[];
  listenAddr?: string;
  advertiseAddr?: string;
  dataPathAddr?: string;
}

/** Options accepted by `SwarmEngine.deploy`. */
export interface DeployOptions {
  sheet?: QuiltSheet;
  sheetPath?: string;
  service?: ServiceSpec;
  image?: string;
  replicas?: number;
  name?: string;
}

/** Options accepted by `SwarmEngine.scale`. */
export interface ScaleOptions {
  service: string;
  replicas: number;
}

/** Options accepted by `SwarmEngine.logs`. */
export interface LogsOptions {
  service: string;
  follow?: boolean;
  tail?: number | 'all';
  since?: number;
  timestamps?: boolean;
  stdout?: boolean;
  stderr?: boolean;
}
