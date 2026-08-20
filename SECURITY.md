# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a vulnerability

Please **do not** file a public GitHub issue for security vulnerabilities.

Email **security@superinstance.dev** (PGP key on request) with:

* A clear description of the issue and impact.
* A reproducer (Docker Compose, command sequence, or test case).
* Your expected disclosure timeline.

We aim to:

* Acknowledge within **2 business days**.
* Triage and assign a CVSS v3.1 score within **5 business days**.
* Ship a fix or mitigation within **30 days** for high/critical issues.

## Threat model

`quilt-swarm` talks to a Docker Engine API socket. The most realistic
threats are:

1. **Privilege escalation** via the Docker socket — only run
   `quilt-swarm` with the minimum required socket permissions.
2. **Secret exfiltration** — secrets are stored in Docker's secret store,
   but a compromised Swarm manager can read them. Use the
   `secrets`/`configs` API to limit access.
3. **Supply chain** — every release is reproducible; verify the
   `dist/` artefacts against the published hashes in the GitHub release.
4. **Insecure overlay networks** — `NetworkManager` forces encryption on
   by default; do not pass `encrypted: false` in production.

## Hardening checklist

* Run Docker Engine with **user namespaces** enabled.
* Mount `/var/run/docker.sock` **read-only** when possible.
* Use the `--secret-driver` flag on the Docker daemon to point secrets at
  an HSM-backed driver.
* Restrict overlay subnets via the `--default-addr-pool` flag passed to
  `quilt-swarm init`.
* Run `quilt-swarm status` periodically and audit the running services.
