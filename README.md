# Agentry Sandbox

Hardened Docker sandboxes on demand for Agentry agents. Each sandbox is one container running E2B's open-source `envd` (processes, terminals, files), reached only through this service's authenticated relay. The Agentry API uses it as its `sandbox` environment provider; browsers never talk to it.

## Setup (development)

1. Node 24 + pnpm 11 (`export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`), Docker running.
2. `pnpm install`
3. `pnpm images:build` — builds `agentry/envd:envd-v0.6.13` (envd from the pinned upstream commit), `agentry/sandbox:1` (default image) and `agentry/netguard:1` (firewall helper).
4. A Postgres database: `createdb agentry_sandbox` (migrations run at startup).
5. Environment:

   | Variable | Default | |
   |---|---|---|
   | `AGENTRY_SANDBOX_DATABASE_URL` | — | required |
   | `AGENTRY_SANDBOX_API_KEYS` | — | required; comma-separated `sha256:<hex>` (`pnpm exec tsx scripts/hash-key.ts <key>`) |
   | `AGENTRY_SANDBOX_SECRET` | — | required, ≥ 32 bytes; **keep it stable** (each sandbox's envd token is derived from it) |
   | `AGENTRY_SANDBOX_HOST` / `_PORT` | `127.0.0.1` / `3090` | |
   | `AGENTRY_SANDBOX_ENVD_REACH` | `loopback` | `loopback` (Docker Desktop) or `ip` (native Docker on the same host) |
   | `AGENTRY_SANDBOX_RUNTIME` | `runc` | `runsc` for gVisor |
   | `AGENTRY_SANDBOX_EGRESS` | `on` | the network guard |
   | `AGENTRY_SANDBOX_IDLE_MINUTES` | `30` | idle sandboxes are stopped (not deleted) |
   | `AGENTRY_SANDBOX_CPUS` / `_MEMORY_MB` / `_PIDS` | `2` / `4096` / `4096` | per-sandbox limits |
   | `AGENTRY_SANDBOX_DEFAULT_IMAGE` / `_ENVD_IMAGE` | `agentry/sandbox:1` / `agentry/envd:envd-v0.6.13` | |

   **Limits** (so no caller or agent can run away with resources; going over one answers 429 `quota_exceeded` with the reason):

   | Variable | Default | |
   |---|---|---|
   | `AGENTRY_SANDBOX_MAX_PER_OWNER` | `5` | sandboxes an owner may have (running or stopped) |
   | `AGENTRY_SANDBOX_MAX_RUNNING_PER_OWNER` | `2` | running at once per owner |
   | `AGENTRY_SANDBOX_MAX_TOTAL` | `50` | sandboxes on the whole service |
   | `AGENTRY_SANDBOX_MAX_RUNNING_TOTAL` | `10` | running at once across everyone |
   | `AGENTRY_SANDBOX_MAX_CREATES_PER_HOUR` | `20` | creates plus resets per owner in any hour |
   | `AGENTRY_SANDBOX_MAX_CPUS` / `_MAX_MEMORY_MB` | `4` / `8192` | the most a template may ask for (400 if more) |
   | `AGENTRY_SANDBOX_OWNER_LIMITS` | — | per-owner overrides, JSON: `{"alice":{"maxPerOwner":10,"maxRunningPerOwner":4,"maxCreatesPerHour":50}}` |

6. Run in herdr: `hc run --bg --no-parent --outlive-parent --name agentry-sandbox -- pnpm dev`, then `AGENTRY_SANDBOX_KEY=<key> pnpm exec tsx scripts/smoke.ts`.

## Security model

- **Container wall:** default seccomp, `CapDrop: ALL` plus a short list (no `NET_RAW`, `NET_ADMIN`, `SYS_ADMIN`), not privileged, no bind mounts, no Docker socket, pids/cpu/memory limits; gVisor with one setting.
- **Inside:** the agent is `agent` (uid 1000) with passwordless sudo — full freedom within its container.
- **Network:** each owner gets a bridge with inter-container traffic off; firewall rules (tagged `agentry-…`, re-checked on every start) let sandboxes reach the internet but not the Docker host, the LAN, private ranges or metadata addresses. A template with `network: false` gets no outbound connections.
- **envd:** its port is published on `127.0.0.1` only (or reached on the container IP); every call needs the per-sandbox token `HMAC-SHA256(secret, sandboxId)`, which only this service knows and never stores.
- **API:** bearer keys (stored as SHA-256 hashes), `X-Agentry-Owner` on every call, owner-scoped records; another owner's id is a 404.

## Third-party

`envd` and its API spec (`third_party/envd/`) come from [e2b-dev/runtime](https://github.com/e2b-dev/runtime) under the Apache License 2.0, unmodified; see `third_party/envd/LICENSE` and `NOTICE.md`.
