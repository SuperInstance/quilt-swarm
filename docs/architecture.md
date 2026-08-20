# Quilt-Swarm Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Quilt-Swarm                                │
│                                                                   │
│   ┌───────────────┐  ┌───────────────┐  ┌────────────────────┐   │
│   │ SwarmEngine   │  │ ServiceMgr    │  │ SecretMgr /        │   │
│   │ (high level)  │  │ (cell→svc)    │  │ NetworkMgr         │   │
│   └──────┬────────┘  └──────┬────────┘  └─────────┬──────────┘   │
│          └──────────────┬────┴────────────────┬──┘                │
│                         ▼                     ▼                    │
│                   ┌─────────────────────────────┐                 │
│                   │        SwarmAdapter         │                 │
│                   │   (dockerode wrapper)        │                 │
│                   └─────────────┬───────────────┘                 │
└─────────────────────────────────┼─────────────────────────────────┘
                                  │ Docker Engine API
                                  ▼
              ┌──────────────────────────────────────┐
              │          Docker Swarm cluster         │
              │   ┌─────────┐  ┌─────────┐  ┌─────┐ │
              │   │ mgr     │  │ worker  │  │ ... │ │
              │   └─────────┘  └─────────┘  └─────┘ │
              │   overlay + IPsec encryption by def. │
              └──────────────────────────────────────┘
```

## Layers

1. **Quilt cell layer** — A Quilt sheet is a two-dimensional grid where each
   cell carries a *kind* (`value`, `formula`, `text`, `image`, `vault`,
   `network`). The kind drives how the cell is translated into a Swarm
   artifact.

2. **ServiceManager** — converts cells into `ServiceSpec` records. Image
   cells become the container image; value cells become environment
   variables; formula cells produce sidecar refreshers; vault cells become
   Docker secrets; network cells add overlay attachments.

3. **SwarmAdapter** — a thin wrapper around [dockerode][dockerode] that
   handles the actual Docker Engine API calls. All other layers go through
   this adapter so that the rest of the codebase can be tested without a
   live Docker socket.

4. **SwarmEngine** — the high-level orchestrator that glues the layers
   together and exposes the public API (`init`, `join`, `leave`,
   `deploy`, `scale`, `rm`, `ps`, `logs`, …).

5. **Quilt-Swarm CLI** — a `commander`-based CLI that maps shell commands
   to engine method calls.

## Cell translation table

| Cell kind | Example                    | Swarm artifact                                      |
| --------- | -------------------------- | --------------------------------------------------- |
| `value`   | `3000`                     | `env` entry on the service                          |
| `formula` | `=sha256(now)`             | config + sidecar that refreshes the value           |
| `text`    | `Welcome to the demo`      | label (`quilt.description`, `quilt.cell.<ref>`)     |
| `image`   | `nginx:1.27`               | `Image` of the task template                        |
| `vault`   | `!vault database-url`      | Docker secret mounted at `/run/secrets/<name>`      |
| `network` | `!net quilt-overlay`       | Overlay network attached to the service             |

## Networking

Every overlay created by `NetworkManager.ensure` is encrypted by default
(`Encrypted: true`). The default subnet pool is `10.128.0.0/16`; override
with the `defaultSubnet` option to fit a different IP plan.

## Secrets

`SecretManager` keeps a local cache of the secret name → Docker secret id
mapping so that rotations are in-place. The first call to
`SecretManager.upsert` creates the secret; subsequent calls update the
data via Docker's secret-update API, preserving the immutable secret id.
This means services that reference the secret do not need to be redeployed
when the data rotates.

## Why Docker Swarm + Quilt?

* **Operational simplicity.** Swarm ships in Docker Engine itself; no
  separate control plane to install.
* **Batteries-included overlay networking** with IPsec encryption on by
  default. Quilt turns it on for *every* network, where Swarm leaves the
  default off for backwards compatibility.
* **Native Compose compatibility.** Most teams already have a
  `docker-compose.yml`; Quilt is the missing orchestration layer.
* **Lower floor than Kubernetes.** A single-node Swarm can be brought up
  in seconds; Quilt is the upgrade path when you outgrow vanilla Compose.

## When to pick Kubernetes / Nomad instead

* You need a large ecosystem of CRDs and operators.
* You need a managed control plane with strict compliance certifications.
* You are running > 1000 nodes per cluster.

For everything in between, Swarm + Quilt is a more economical choice.

## See also

* [`quilt-core`][quilt-core] — the Quilt type system and cell model.
* [`quilt-base`][quilt-base] — base cells and runtime helpers.
* [`quilt-fleet`][quilt-fleet] — multi-cluster fleet orchestration.
* [`quilt-elf`][quilt-elf] — executable Quilt cell binaries.

[dockerode]: https://github.com/apocas/dockerode
[quilt-core]: https://github.com/SuperInstance/quilt-core
[quilt-base]: https://github.com/SuperInstance/quilt-base
[quilt-fleet]: https://github.com/SuperInstance/quilt-fleet
[quilt-elf]: https://github.com/SuperInstance/quilt-elf
