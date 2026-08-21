# 🐳 quilt-swarm

> **Quilt as a control plane for Docker Swarm.** Edit a spreadsheet cell. The Swarm cluster re-configures. Encrypted overlay networking, service mesh, secret rotation — all from a Quilt sheet.

<p align="center">
  <img src="assets/splash.png" alt="quilt-swarm: distributed orchestration" width="800">
</p>

<p align="center">
  <a href="#why-this-exists">Why</a> •
  <a href="#the-philosophy">Philosophy</a> •
  <a href="#concrete-proof">Concrete proof</a> •
  <a href="#real-world-scenarios">Scenarios</a> •
  <a href="#try-it-right-now">Try it</a> •
  <a href="#how-it-fits-in-the-ecosystem">Ecosystem</a>
</p>

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0-orange.svg)](./package.json)
[![tests](https://img.shields.io/badge/tests-28%2F28%20passing-brightgreen.svg)](./test)
[![typescript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)

---

## ✦ Why this exists

You have services. They need to be deployed, scaled, updated, and observed. You could learn Kubernetes. You could learn Nomad. You could write your own orchestrator. Or you could use Docker Swarm, which is built into every Docker install, has been battle-tested for a decade, and just works.

But Swarm is also tedious. Writing stack files by hand, tracking replicas across services, rotating secrets without downtime, managing networks and volumes — all of these are solvable problems that nevertheless take days of work to get right.

`quilt-swarm` gives you a Quilt sheet that compiles to a Swarm cluster. You edit cells. The cluster changes. You focus on what your services do, not on how the orchestration layer works.

## ✦ The philosophy

A control plane should be invisible. When you tell a database to scale to 10 replicas, you don't want to write a deployment YAML, push it through CI, wait for the rollout, monitor the new pods, and hope nothing broke. You want to say "10" and have it be 10.

Quilt already gives you that for computation. A formula cell updates when its dependencies change. A listener fires when something else fires. A value cell is a knob you can turn. Now apply that to infrastructure. A `value` cell becomes a service count. A `formula` cell becomes a service spec. A `program` cell is the action you take when a service dies. The whole orchestration becomes a reactive spreadsheet.

```
┌──────────────────────────────────────────────────────────┐
│                 Quilt Sheet (your code)                  │
│                                                          │
│  { "path": "replicas",    "kind": "value", "value": 3 }  │
│  { "path": "image",       "kind": "value",              │
│                            "value": "nginx:1.27" }       │
│  { "path": "web",         "kind": "formula",            │
│                            "fn": "..." }                │
│  { "path": "health",      "kind": "api",                │
│                            "endpoint": "..." }          │
│                                                          │
└────────────────────────┬─────────────────────────────────┘
                         │ quilt-swarm compiles
                         ▼
┌──────────────────────────────────────────────────────────┐
│              Docker Swarm cluster                        │
│                                                          │
│   ┌────────┐  ┌────────┐  ┌────────┐                    │
│   │ node-1│  │ node-2 │  │ node-3 │  ← overlay network │
│   │        │  │        │  │        │     (encrypted)   │
│   │  ┌──┐  │  │  ┌──┐  │  │  ┌──┐  │                    │
│   │  │W1│  │  │  │W2│  │  │  │W3│  │  ← service tasks  │
│   │  └──┘  │  │  └──┘  │  │  └──┘  │                    │
│   └────────┘  └────────┘  └────────┘                    │
│                                                          │
│   ┌────────┐  encrypted secrets, mounts, configs         │
│   │ secrets│  ← rotated without downtime                 │
│   └────────┘                                             │
└──────────────────────────────────────────────────────────┘
```

The Swarm cluster runs the services. The Quilt sheet describes them. You don't write stack files. You don't push through CI. You change a number and the cluster follows.

## ✦ Concrete proof

**1. Deploy a service from a sheet:**

```ts
import { QuiltEngine } from '@quilt/core';
import { SwarmEngine } from '@quilt/swarm';

const swarm = new SwarmEngine({ address: 'http://swarm-manager:2377' });
const quilt = new QuiltEngine('my-app');

quilt.loadSheet({
  name: 'web',
  cells: [
    { path: 'replicas', kind: 'value', value: 3 },
    { path: 'image', kind: 'value', value: 'nginx:1.27' },
    { path: 'web', kind: 'formula',
      fn: (ctx) => ({ name: 'web', image: ctx.image, replicas: ctx.replicas }) },
  ],
});

// Now deploy
await swarm.apply(quilt.currentSheet());
// 3 nginx containers across the cluster, encrypted overlay network
```

**2. Scale without downtime:**

```ts
quilt.set('replicas', 10);
// Swarm does a rolling update: 1 → 2 → 3 → ... → 10
// No dropped requests, no manual YAML editing
```

**3. Rotate a secret in place:**

```ts
const newSecret = await swarm.secrets.rotate('db-password', 'new-value-123');
// Secret ID is preserved — services keep their mount
// Only the underlying data changes
// No service restart required
```

**4. Encrypted overlay network:**

```ts
const net = await swarm.networks.ensure('quilt-overlay', { encrypted: true });
// WireGuard tunnel between every node
// Every service-to-service packet is encrypted
// Zero configuration needed
```

## ✦ Real-world scenarios

**📊 A/B testing at scale** — A team runs 50 variants of their landing page. The variant count is a `value` cell. Quilt ensures exactly that many services are running. Switch the cell to 51? Five seconds later, the new variant is live. Switch to 0? All 50 are scaled down, costs drop, the test ends.

**🌍 Multi-region deployment** — A SaaS team runs 6 regional clusters. Each cluster runs `quilt-swarm`. The Quilt sheet is shared via `FederatedArtifactStore` (from `@quilt/sdk`). Edit the cell in one place, all 6 clusters update. Regional differences are first-class `value` cells per region.

**🔐 Compliance-as-code** — A regulated industry needs to prove that secrets are rotated every 30 days. The rotation schedule is a `formula` cell that returns the next rotation date. When the date passes, a `listener` cell calls `secrets.rotate()`. Every rotation is logged. The auditor can read the Quilt sheet and see the whole story.

**🏥 Zero-downtime deploys** — A hospital runs 24/7. Deploys happen during business hours. The Quilt cell has a `listener` that monitors health, a `value` cell for the desired replica count, and a `formula` cell that calculates the canary percentage. A single edit rolls out a new version with safety checks baked in.

## ✦ Try it right now

```bash
# Install
npm install @quilt/swarm

# Initialize a Swarm (if you don't have one)
docker swarm init

# Run the dev example
git clone https://github.com/SuperInstance/quilt-swarm
cd quilt-swarm
npm install
npm run example
```

Or browse the [live Quilt + Swarm demo](https://superinstance.dev/nomad-demo.html) to see the concept in action.

## ✦ How it fits in the ecosystem

`quilt-swarm` is one of two embedded orchestrators in the Quilt ecosystem:

```
                    ┌────────────────────┐
                    │   Quilt cells      │
                    │   (your logic)     │
                    └──────────┬─────────┘
                               │
                ┌──────────────┴──────────────┐
                │                             │
         ┌──────▼──────┐              ┌───────▼──────┐
         │ quilt-swarm │              │  quilt-nomad │
         │  (Docker)   │              │ (multi-task) │
         └──────┬──────┘              └───────┬──────┘
                │                              │
                ▼                              ▼
         Docker Swarm cluster         HashiCorp Nomad cluster
         (containers only)            (containers, exec, Java, ...)
```

**Use `quilt-swarm` when:**
- You only need containers
- You already have Docker installed
- You want minimal infrastructure complexity
- You're deploying to edge devices with limited resources

**Use `quilt-nomad` when:**
- You need to run containers AND standalone binaries AND Java JARs
- You have complex scheduling requirements (bin-packing, affinity, etc.)
- You want rich job templating with HCL
- You have multi-datacenter deployments

Both repos share the same Quilt cell mapping convention. Switching between them is a one-line change in your code.

## ✦ Why you should care

If you've ever spent a day writing a Compose file only to find that one service doesn't start in the right order. If you've ever manually rotated a secret and watched 30 services restart. If you've ever written Helm charts to do what should be simple. If you've ever wished that "make it 5 instead of 3" was a one-character change.

This repo is for you.

## ✦ License

Apache 2.0. See [LICENSE](./LICENSE).
