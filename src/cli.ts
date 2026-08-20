#!/usr/bin/env node
/**
 * Quilt-Swarm CLI entry point.
 *
 * Provides a thin wrapper around the SwarmEngine that is convenient to
 * drive from a shell. Every command is a thin shim; the real work is in
 * the engine.
 */

import { Command } from 'commander';

import { SwarmEngine } from './swarm-engine.js';
import { DockerodeLike } from './swarm-adapter.js';
import type {
  DeployOptions,
  InitOptions,
  JoinOptions,
  LogsOptions,
  ScaleOptions,
} from './types.js';

/** Build a Docker client from environment variables. */
async function buildDockerClient(): Promise<DockerodeLike> {
  // We dynamically import dockerode so the rest of the CLI can run
  // in environments where the native module is not yet compiled.
  const mod = await import('dockerode');
  const Dockerode = mod.default ?? (mod as unknown as { Dockerode: unknown }).Dockerode;
  const DockerCtor = Dockerode as new (opts: Record<string, unknown>) => DockerodeLike;
  const socketPath = process.env['DOCKER_SOCKET_PATH'] ?? '/var/run/docker.sock';
  const host = process.env['DOCKER_HOST'];
  if (host) {
    return new DockerCtor({ host });
  }
  return new DockerCtor({ socketPath });
}

function buildEngine(): Promise<SwarmEngine> {
  return buildDockerClient().then((docker) => new SwarmEngine({ docker }));
}

export class QuiltSwarmCLI {
  private readonly program: Command;
  private engine: SwarmEngine | null = null;

  constructor(name = 'quilt-swarm') {
    this.program = new Command();
    this.program
      .name(name)
      .description('Quilt as a unified control plane over Docker Swarm clusters')
      .version('0.1.0');
    this.registerCommands();
  }

  /** Return the underlying commander program (for testing). */
  program$(): Command {
    return this.program;
  }

  /** Lazily resolve the engine so dry-runs don't need a Docker socket. */
  private async engine$(): Promise<SwarmEngine> {
    if (!this.engine) this.engine = await buildEngine();
    return this.engine;
  }

  /** Reset the engine (mainly for tests). */
  resetEngine(): void {
    this.engine = null;
  }

  private registerCommands(): void {
    this.program
      .command('init')
      .description('Initialise a new Docker Swarm cluster')
      .requiredOption('-a, --advertise-addr <addr>', 'Advertise address for this manager')
      .option('--listen-addr <addr>', 'Listen address (default 0.0.0.0:2377)')
      .option('--data-path-addr <addr>', 'Data path address')
      .option('--default-addr-pool <pool>', 'Default address pool (CIDR list)')
      .option('--subnet-size <size>', 'Default subnet size (bits)')
      .option('--force-new-cluster', 'Force initialisation of an existing cluster')
      .action(async (flags) => {
        const opts: InitOptions = {
          advertiseAddr: String(flags.advertiseAddr),
          listenAddr: flags.listenAddr ? String(flags.listenAddr) : undefined,
          dataPathAddr: flags.dataPathAddr ? String(flags.dataPathAddr) : undefined,
          defaultAddrPool: flags.defaultAddrPool
            ? String(flags.defaultAddrPool).split(',')
            : undefined,
          subnetSize: flags.subnetSize ? Number(flags.subnetSize) : undefined,
          forceNewCluster: Boolean(flags.forceNewCluster),
        };
        const engine = await this.engine$();
        const result = await engine.init(opts);
        process.stdout.write(`Swarm initialised: ${result.swarmId}\n`);
      });

    this.program
      .command('join')
      .description('Join an existing Swarm as a worker or manager')
      .requiredOption('--token <token>', 'Join token from `swarm join-token`')
      .requiredOption('--remote <addr>', 'Remote manager address (host:port)')
      .option('--listen-addr <addr>', 'Listen address')
      .option('--advertise-addr <addr>', 'Advertise address')
      .action(async (flags) => {
        const opts: JoinOptions = {
          joinToken: String(flags.token),
          remoteAddrs: String(flags.remote).split(','),
          listenAddr: flags.listenAddr ? String(flags.listenAddr) : undefined,
          advertiseAddr: flags.advertiseAddr ? String(flags.advertiseAddr) : undefined,
        };
        const engine = await this.engine$();
        await engine.join(opts);
        process.stdout.write('Joined swarm.\n');
      });

    this.program
      .command('leave')
      .description('Leave the current Swarm cluster')
      .option('--force', 'Force leave even if this is a manager')
      .action(async (flags) => {
        const engine = await this.engine$();
        await engine.leave(Boolean(flags.force));
        process.stdout.write('Left swarm.\n');
      });

    this.program
      .command('deploy')
      .description('Deploy services from a Quilt sheet or inline image')
      .option('-f, --file <path>', 'Path to a Quilt sheet (YAML)')
      .option('-n, --name <name>', 'Service name (for inline deploys)')
      .option('-i, --image <image>', 'Container image (for inline deploys)')
      .option('-r, --replicas <count>', 'Replica count', '1')
      .action(async (flags) => {
        const opts: DeployOptions = {
          sheetPath: flags.file ? String(flags.file) : undefined,
          name: flags.name ? String(flags.name) : undefined,
          image: flags.image ? String(flags.image) : undefined,
          replicas: flags.replicas ? Number(flags.replicas) : undefined,
        };
        const engine = await this.engine$();
        const result = await engine.deploy(opts);
        process.stdout.write(
          `Deployed ${result.service} (${result.replicas}× ${result.image})\n`,
        );
      });

    this.program
      .command('scale')
      .description('Scale a service to the specified number of replicas')
      .requiredOption('-s, --service <name>', 'Service name')
      .requiredOption('-r, --replicas <count>', 'Replica count')
      .action(async (flags) => {
        const opts: ScaleOptions = {
          service: String(flags.service),
          replicas: Number(flags.replicas),
        };
        const engine = await this.engine$();
        const result = await engine.scale(opts);
        process.stdout.write(`Scaled ${opts.service} to ${result.replicas}\n`);
      });

    this.program
      .command('status')
      .description('Print cluster and service status')
      .option('--json', 'Output as JSON')
      .action(async (flags) => {
        const engine = await this.engine$();
        const status = await engine.status();
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `Swarm: ${status.swarmId ?? '(none)'}  node=${status.nodeId ?? '(none)'}  ` +
            `managers=${status.managers}  workers=${status.workers}\n`,
        );
        for (const svc of status.services) {
          process.stdout.write(
            `  ${svc.name.padEnd(28)} ${svc.state.padEnd(8)} ${svc.running}/${svc.desired}  ${svc.image}\n`,
          );
        }
      });

    this.program
      .command('ps')
      .description('List services running in the cluster')
      .action(async () => {
        const engine = await this.engine$();
        const services = await engine.ps();
        for (const svc of services) {
          process.stdout.write(
            `${svc.name}\t${svc.running}/${svc.desired}\t${svc.image}\n`,
          );
        }
      });

    this.program
      .command('logs')
      .description('Fetch recent logs for a service')
      .requiredOption('-s, --service <name>', 'Service name')
      .option('--tail <n>', 'Number of lines from the end', '50')
      .option('--since <ts>', 'Show logs since timestamp (unix seconds)')
      .action(async (flags) => {
        const tail = String(flags.tail);
        const opts: LogsOptions = {
          service: String(flags.service),
          tail: tail === 'all' ? 'all' : Number(tail),
          since: flags.since ? Number(flags.since) : undefined,
          timestamps: true,
        };
        const engine = await this.engine$();
        const lines = await engine.logs(opts.service, opts);
        for (const line of lines) {
          process.stdout.write(`${line.timestamp} ${line.message}\n`);
        }
      });

    this.program
      .command('rm')
      .description('Remove a service from the cluster')
      .argument('<service>', 'Service name')
      .option('--force', 'Force removal')
      .action(async (service: string, flags) => {
        const engine = await this.engine$();
        await engine.rm(service, Boolean(flags.force));
        process.stdout.write(`Removed ${service}\n`);
      });

    this.program
      .command('secret:set')
      .description('Create or update a secret from a literal value')
      .argument('<name>', 'Secret name')
      .argument('<value>', 'Secret value')
      .action(async (name: string, value: string) => {
        const engine = await this.engine$();
        const r = await engine.upsertSecret(name, value);
        process.stdout.write(`Secret ${r.name} → ${r.id}\n`);
      });

    this.program
      .command('secret:rotate')
      .description('Rotate an existing secret in place')
      .argument('<name>', 'Secret name')
      .argument('<value>', 'New secret value')
      .action(async (name: string, value: string) => {
        const engine = await this.engine$();
        const r = await engine.rotateSecret(name, value);
        process.stdout.write(`Rotated ${r.name} to version ${r.version}\n`);
      });

    this.program
      .command('network:ensure')
      .description('Ensure an encrypted overlay network exists')
      .argument('<name>', 'Network name')
      .option('--subnet <cidr>', 'Subnet (CIDR)')
      .action(async (name: string, flags) => {
        const engine = await this.engine$();
        const r = await engine.networks.ensure({
          name,
          subnet: flags.subnet ? String(flags.subnet) : undefined,
        });
        process.stdout.write(`Network ${r.name} (${r.id}) encrypted=${r.encrypted}\n`);
      });
  }

  /** Parse argv and execute. */
  async run(argv: string[]): Promise<void> {
    await this.program.parseAsync(argv);
  }
}

const isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === new URL(`file://${entry}`).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const cli = new QuiltSwarmCLI();
  cli.run(process.argv).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`quilt-swarm: ${msg}\n`);
    process.exit(1);
  });
}
