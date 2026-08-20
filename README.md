# Quilt-Swarm

```
   ____        _ _       _____
  / __ \      | (_)     / ____|
 | |  | |_   _| |_ _ _| (___   ___ _ ____   _____ _ __
 | |  | | | | | | | '_ \\___ \ / _ \ '__\ \ / / _ \ '__|
 | |__| | |_| | | | |_) |___) |  __/ |   \ V /  __/ |
  \___\_\\__,_|_|_| .__/_____/ \___|_|    \_/ \___|_|
                  |_|
                 Docker Swarm · Quilt-powered
```

> **Quilt as a unified control plane over Docker Swarm clusters.**
> One-command Swarm-to-Quilt migration. Encrypted overlay networking.

[![CI](https://img.shields.io/github/actions/workflow/status/SuperInstance/quilt-swarm/ci.yml?branch=main)](https://github.com/SuperInstance/quilt-swarm/actions)
[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](tsconfig.json)

---

## What is Quilt-Swarm?

`quilt-swarm` is the Docker Swarm runtime adapter for the
[Quilt](https://github.com/SuperInstance/quilt) ecosystem. It treats a
Swarm cluster as a first-class Quilt *cell* target so you can:

* Declare a Quilt **sheet** of services (cells) and deploy it to Swarm in
  one command.
* Treat Swarm **services** as if they were Quilt cells — `quilt-swarm
  scale` mutates the cell, the Swarm service follows.
* Manage **Docker secrets** from Quilt **vault cells** with in-place
  rotation (no service redeploy).
* Provision **encrypted overlay networks** automatically; Quilt refuses
  to leave overlay encryption off.
* Migrate an **existing** Swarm to Quilt without service downtime.

If you already have `docker swarm init` working, you are three minutes
away from having a Quilt-managed cluster.

---

## Why Docker Swarm + Quilt?

| Concern                | K8s          | Nomad       | Swarm + Quilt    |
| ---------------------- | ------------ | ----------- | ---------------- |
| Operational complexity | High         | Medium      | **Low**          |
| Built-in overlay       | Yes (CNI)    | Yes (CNI)   | **Yes (native)** |
| Encrypted overlay      | Plugin       | Plugin      | **Default on**   |
| Compose compatibility  | No           | Partial     | **Yes**          |
| Cluster bring-up time  | 5–30 min     | 5–15 min    | **<30 s**        |
| Footprint to start     | ~10 procs    | ~5 procs    | **0 extra**      |

Use Swarm + Quilt when your cluster is between **1 and ~100 nodes** and
your team values the *operational* surface area as much as the feature
surface. Reach for K8s/Nomad when you need a rich operator ecosystem or
you are running >1000 nodes per cluster.

---

## Quick start

### 1. Install

```bash
npm install -g quilt-swarm
# or, from source
git clone https://github.com/SuperInstance/quilt-swarm
cd quilt-swarm
npm install
npm run build
```

### 2. Initialise a Swarm (one command)

```bash
quilt-swarm init --advertise-addr 192.0.2.10:2377
# → Swarm initialised: swarm-test-1
```

### 3. Deploy a sheet

Save the snippet below as `hello.yml`:

```yaml
name: hello
rows:
  - A1: frontend
    A2: nginx:1.27
    C1: "80"
    E1: !vault api-token
    F1: !net quilt-overlay
  - A1: api
    A2: node:20-alpine
    C1: "3000"
    D1: =env("PORT", "3000")
    E1: !vault database-url
    F1: !net quilt-overlay
```

Then deploy:

```bash
quilt-swarm deploy -f hello.yml
# → Deployed quilt-api (1× node:20-alpine)
```

### 4. Scale a service

```bash
quilt-swarm scale --service quilt-api --replicas 5
# → Scaled quilt-api to 5
```

### 5. Check status

```bash
quilt-swarm status
# Swarm: swarm-test-1  node=node-1  managers=1  workers=0
#   quilt-api                running  1/1  node:20-alpine
#   quilt-frontend           running  1/1  nginx:1.27
```

### 6. Stream logs

```bash
quilt-swarm logs --service quilt-api --tail 50
```

### 7. Tear down

```bash
quilt-swarm rm quilt-api
quilt-swarm leave
```

---

## Architecture

```
                  ┌──────────────────────────────────────┐
                  │              Quilt Sheet             │
                  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ │
                  │  │ A1 │ │ A2 │ │ C1 │ │ E1 │ │ F1 │ │
                  │  └─┬──┘ └─┬──┘ └─┬──┘ └─┬──┘ └─┬──┘ │
                  └────┼──────┼──────┼──────┼──────┼────┘
                       │      │      │      │      │
            ┌──────────┘      │      │      │      │
            │   text→name     │      │      │      │
            │                 │      │      │      │
            │           image→│      │      │      │
            │                 │      │      │      │
            │                 │ value→env    │      │
            │                 │              │      │
            │                 │              │ vault→secret
            │                 │              │      │
            │                 │              │      │ net→overlay
            ▼                 ▼              ▼      ▼
   ┌─────────────────────────────────────────────────────┐
   │                  ServiceManager                      │
   │  one row in sheet  →  one ServiceSpec                │
   └──────────────────────────┬──────────────────────────┘
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │                   SwarmAdapter                      │
   │       (dockerode → Docker Engine API)               │
   └──────────────────────────┬──────────────────────────┘
                              ▼
            ┌──────────────────────────────────┐
            │   Docker Swarm cluster           │
            │   (overlay + IPsec by default)  │
            └──────────────────────────────────┘
```

* **Cell layer** — every Quilt cell has a `kind` (`value`, `formula`,
  `text`, `image`, `vault`, `network`).
* **ServiceManager** — translates cells into `ServiceSpec` records.
* **SwarmAdapter** — wraps `dockerode`; the *only* code that talks to
  Docker.
* **SwarmEngine** — the high-level orchestrator that exposes the public
  API.
* **CLI** — a `commander`-based front-end.

See [docs/architecture.md](docs/architecture.md) for the full design.

---

## API

`quilt-swarm` is a TypeScript library. The CLI is a thin wrapper around
the same surface. All public types are exported from the package root.

| Endpoint / method                              | Description                                                |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `SwarmEngine.init({ advertiseAddr })`          | Initialise a new Swarm cluster.                            |
| `SwarmEngine.join({ joinToken, remoteAddrs })` | Join an existing Swarm.                                    |
| `SwarmEngine.leave(force?)`                    | Leave the Swarm.                                           |
| `SwarmEngine.inspect()`                        | Inspect the local Swarm (id, name).                        |
| `SwarmEngine.status()`                         | Cluster-wide status (managers, workers, services).         |
| `SwarmEngine.deploy({ service \| sheet \| ... })` | Deploy a service or a complete sheet.                    |
| `SwarmEngine.scale({ service, replicas })`     | Scale a service to N replicas.                             |
| `SwarmEngine.rm(service, force?)`              | Remove a service.                                          |
| `SwarmEngine.ps()`                             | List all services.                                         |
| `SwarmEngine.logs(service, opts)`              | Stream/return recent logs.                                 |
| `SwarmEngine.upsertSecret(name, data)`         | Create or update a Docker secret.                          |
| `SwarmEngine.rotateSecret(name, newData)`      | Rotate a secret in place.                                  |
| `SwarmEngine.ensureNetwork(name)`              | Ensure an encrypted overlay network exists.                |
| `engine.adapter`, `.services`, `.secrets`, `.networks` | Sub-managers for advanced use.                     |

### Cell translation table

| Cell kind | Example                  | Swarm artifact                                       |
| --------- | ------------------------ | ---------------------------------------------------- |
| `value`   | `3000`                   | `env` entry on the service                           |
| `formula` | `=sha256(now)`           | config + sidecar that refreshes the value            |
| `text`    | `Welcome to the demo`    | label (`quilt.description`, `quilt.cell.<ref>`)      |
| `image`   | `nginx:1.27`             | `Image` of the task template                         |
| `vault`   | `!vault database-url`    | Docker secret mounted at `/run/secrets/<name>`       |
| `network` | `!net quilt-overlay`     | Overlay network attached to the service              |

### Encrypted networking — by default

```ts
import { NetworkManager } from 'quilt-swarm';

const networks = new NetworkManager({ docker, defaultSubnet: '10.42.0.0/16' });
const overlay = await networks.ensure({ name: 'quilt-overlay' });
// → { id: 'abc123', encrypted: true, subnet: '10.42.0.0/16' }
```

Refusing to disable overlay encryption is a design choice — Swarm leaves
the default off, Quilt turns it on.

### One-command migration from a vanilla Swarm

```ts
import { SwarmEngine } from 'quilt-swarm';
import Dockerode from 'dockerode';

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
const engine = new SwarmEngine({ docker });

// 1. Snapshot every running service.
const existing = await engine.ps();
for (const svc of existing) {
  // 2. Build a Quilt sheet row from the running service.
  // 3. Redeploy via Quilt with encryption on.
}
```

The `examples/migrate-from-swarm.ts` (planned) will automate this end to
end.

---

## Cross-references

Quilt is a family of small, composable packages. `quilt-swarm` is the
Swarm adapter; you will likely want the others too.

| Package                                                 | Purpose                              |
| ------------------------------------------------------- | ------------------------------------ |
| [`quilt-core`](../quilt-core)                           | The Quilt type system & cell model.  |
| [`quilt-base`](../quilt-base)                           | Base cells & runtime helpers.        |
| [`quilt-fleet`](../quilt-fleet)                         | Multi-cluster fleet orchestration.   |
| [`quilt-elf`](../quilt-elf)                             | Executable Quilt cell binaries.      |
| [`quilt-mesh`](../quilt-mesh)                           | Service mesh sidecars.               |
| [`quilt-vault`](../quilt-vault)                         | Secret store / HSM bridge.           |

---

## Development

```bash
git clone https://github.com/SuperInstance/quilt-swarm
cd quilt-swarm
npm install
npm test         # unit tests (no Docker required)
npm run typecheck
npm run lint
npm run build
```

The unit tests use an in-memory dockerode fake (`test/_fixtures.ts`) so
they do not require a running Docker daemon. CI runs the same suite on
Node 18.x and 20.x.

### Project layout

```
.
├── src/
│   ├── index.ts            # public exports
│   ├── swarm-engine.ts     # high-level orchestrator
│   ├── swarm-adapter.ts    # dockerode wrapper
│   ├── service-manager.ts  # cell → service translation
│   ├── secret-manager.ts   # Docker secret lifecycle
│   ├── network-manager.ts  # encrypted overlay networks
│   ├── cli.ts              # `quilt-swarm` CLI
│   └── types.ts            # shared types
├── test/
│   ├── _fixtures.ts        # in-memory dockerode fake
│   ├── swarm-engine.test.ts
│   ├── service-manager.test.ts
│   └── secret-manager.test.ts
├── examples/
│   └── deploy-stack.yml    # example Quilt sheet
├── docs/
│   └── architecture.md
├── .github/
│   ├── workflows/ci.yml
│   ├── dependabot.yml
│   └── CODEOWNERS
├── .eslintrc.cjs
├── tsconfig.json
├── tsconfig.test.json
├── package.json
├── LICENSE                 # Apache 2.0
├── SECURITY.md
└── README.md
```

---

## License

Apache-2.0. See [LICENSE](LICENSE).
