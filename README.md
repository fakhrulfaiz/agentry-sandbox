# Agentry Sandbox

Hardened Docker sandboxes on demand for Agentry agents. Each sandbox is one container running E2B's open-source `envd` (processes, terminals, files), reached only through this service's authenticated relay. The Agentry API uses it as its `sandbox` environment provider; browsers never talk to it.

**New here?** Read [`docs/overview.md`](docs/overview.md): what the service is, how envd and the DeepSeek Harness helper fit in, places and drivers, and how the Agentry API uses it.

## Setup (development)

1. Node 24 + pnpm 11 (`export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`), Docker running.
2. `pnpm install`
3. `pnpm images:build` — builds `ghcr.io/fakhrulfaiz/agentry-envd:envd-v0.6.13` (envd from the pinned upstream commit), `ghcr.io/fakhrulfaiz/agentry-dsh-runtime:0.2.2-rc.1` (DeepSeek Harness's remote helper and Node, injected into every sandbox at `/opt/agentry/dsh`), `ghcr.io/fakhrulfaiz/agentry-sandbox:1` (default image) and `ghcr.io/fakhrulfaiz/agentry-netguard:1` (firewall helper). The same images are published (linux/amd64 and linux/arm64) to GHCR by `.github/workflows/images.yml` on every push to `main`; remote Docker places pull them from there, so a remote host needs no local build.
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
   | `AGENTRY_SANDBOX_DEFAULT_IMAGE` / `_ENVD_IMAGE` | `ghcr.io/fakhrulfaiz/agentry-sandbox:1` / `ghcr.io/fakhrulfaiz/agentry-envd:envd-v0.6.13` | |
   | `AGENTRY_SANDBOX_DSH_RUNTIME_IMAGE` | `ghcr.io/fakhrulfaiz/agentry-dsh-runtime:0.2.2-rc.1` | DSH remote helper injected into each sandbox; `none` disables (the Agentry API's tools then cannot run there) |

   **Template cache** (Docker and Docker-over-SSH places): the first create from a template makes the `agent` user, installs the template's packages and copies the DSH runtime, then saves that base as the image `agentry-template-cache:<key>` before running the template's files and setup commands. Later creates with the same base image, packages and runtime start from it and only run files and setup commands. The key is the sha256 of the resolved base image id, the sorted packages, the runtime ref and a bootstrap version, so changing any of them is a miss. Nothing secret is saved: the commit happens before files and setup run, template `env` is never written to disk, the workspace is a volume (not part of a commit), the sandbox and owner labels are blanked, and the envd token is derived, not stored. A failed commit is logged and never fails the create. Cache images are removed oldest-used first beyond the maximum; Docker refuses to remove one a container still uses, so it stays.

   | Variable | Default | |
   |---|---|---|
   | `AGENTRY_SANDBOX_TEMPLATE_CACHE` | `on` | `off` disables the cache |
   | `AGENTRY_SANDBOX_TEMPLATE_CACHE_MAX` | `10` | cache images kept per Docker daemon |

   **Create progress:** while a sandbox is `provisioning`, `GET /v1/sandboxes/{id}` and the list carry `progress`: `{ "stage": "pulling_image" | "starting" | "preparing" | "installing_packages" | "copying_runtime" | "writing_files" | "running_setup" | "finishing", "step", "steps", "detail", "updated_at" }`. `step`, `steps` and `detail` (the setup command, cut to 120 characters) come with `running_setup` only. It is removed when the sandbox leaves `provisioning`.

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

   **Admin page:** `AGENTRY_SANDBOX_ADMIN_KEYS` (optional, same `sha256:<hex>` format, must differ from the API keys) turns on `http://<host>:<port>/admin`: one HTML page (no build) with the service overview, every user's sandboxes (start, stop, delete) and the limits, which can be changed there live. Saved limit overrides are kept in the database (`settings` table) and win over the environment until "Reset to defaults". Its API is `/v1/admin/overview`, `/v1/admin/sandboxes[/{id}[/start|stop]]` and `/v1/admin/limits` (GET, PUT `{ overrides }`, DELETE), admin key only. Without admin keys the page says how to turn it on and `/v1/admin/*` answers 404.

6. Run in herdr: `hc run --bg --no-parent --outlive-parent --name agentry-sandbox bash scripts/dev.sh`, then `AGENTRY_SANDBOX_KEY=<key> pnpm exec tsx scripts/smoke.ts`. `scripts/dev.sh` reads `AGENTRY_SANDBOX_KEY`, `AGENTRY_SANDBOX_SECRET` and `AGENTRY_SANDBOX_ADMIN_KEY` from the Agentry API's git-ignored `.env` (`~/code/dsh-agents-api/.env`, or `AGENTRY_ENV_FILE`), hashes the keys and finds the database password from the `agentry-postgres` container.

## Run it from the image

`ghcr.io/fakhrulfaiz/agentry-sandbox-service` is the service (distinct from `agentry-sandbox`, the default sandbox base image). `docker/compose.yaml` runs it with its own Postgres on a Linux host: `cp docker/agentry-sandbox.env.example .env`, set `POSTGRES_PASSWORD`, `AGENTRY_SANDBOX_KEY` and `AGENTRY_SANDBOX_SECRET`, then `docker compose -f docker/compose.yaml up -d`. The container mounts the host's Docker socket (the service drives Docker; the sandboxes never get it) and uses the host network; `docker/README.md` explains both. Releases: a merge to `main` with a new `package.json` version publishes the image and a `v<version>` GitHub Release (notes from the `## <version>` section of `CHANGELOG.md`). The Agentry API and Web composes start it with `COMPOSE_PROFILES=sandbox`.

## Security model

- **Container wall:** default seccomp, `CapDrop: ALL` plus a short list (no `NET_RAW`, `NET_ADMIN`, `SYS_ADMIN`), not privileged, no bind mounts, no Docker socket, pids/cpu/memory limits; gVisor with one setting.
- **Inside:** the agent is `agent` (uid 1000) with passwordless sudo — full freedom within its container.
- **Network:** each owner gets a bridge with inter-container traffic off; firewall rules (tagged `agentry-…`, re-checked on every start) let sandboxes reach the internet but not the Docker host, the LAN, private ranges or metadata addresses. A template with `network: false` gets no outbound connections.
- **envd:** its port is published on `127.0.0.1` only (or reached on the container IP); every call needs the per-sandbox token `HMAC-SHA256(secret, sandboxId)`, which only this service knows and never stores.
- **API:** bearer keys (stored as SHA-256 hashes), `X-Agentry-Owner` on every call, owner-scoped records; another owner's id is a 404.

## SSH machine places

A place of kind "Machine over SSH" (added on the admin page like a Docker-over-SSH place: address, private key, test, confirm the host key) runs sandboxes directly on a Linux machine, with no container. There is no isolation between sandboxes and the agent has the SSH user's sudo, so use it only for a machine you are happy to give agents.

- **Requirements:** Linux x86_64 or aarch64 with glibc, an SSH user with passwordless sudo (and no `requiretty` for that user), and `iptables` (and `ip6tables` when the machine has IPv6).
- **What Agentry writes:** `~/.agentry/bin` (the envd binary), `~/.agentry/sandboxes/<id>/` (its metadata, pid and log), the sandbox's workspace path (default `/workspace`, created and owned by the SSH user), `/opt/agentry/dsh` (the DSH runtime, shared by the machine's sandboxes, the previous one kept as `dsh.prev`), and per-sandbox firewall rules tagged `agentry-<id>`.
- **Who can reach envd:** the rules drop envd's port on every interface but loopback and reject loopback connections from every user but the SSH user (iptables `owner` match), so other local users cannot reach envd before it is initialised. The window before the first `/init` is what these rules cover. Once `/init` has set a token (verified on envd envd-v0.6.13, 2026-11-25), an unauthenticated `/init` is rejected with 401, and so are requests with another token.
- **Workspaces:** a sandbox's workspace must not exist yet; create refuses an existing directory, so a data volume or home directory can never be adopted or deleted. The driver creates it, owned by the SSH user, with a `.agentry-sandbox` marker holding the sandbox id. Delete removes the workspace only when it is named `sandbox-...` and its marker holds that sandbox's id; any other workspace is left in place (a warning is logged). Files that agents create elsewhere stay where they are.
- **Stop** ends envd and its whole session (setsid; everything the agent started under it) and then removes its firewall rules; if something survives SIGKILL the stop fails and the rules stay. Files and the workspace stay. A process that calls `setsid` (or `systemd-run`, a double fork into a new session) itself escapes the session and survives stop, so GPUs are not guaranteed to be free after a stop on this kind. **Delete** also removes the sandbox's `~/.agentry/sandboxes/<id>/` directory and, per the rule above, its workspace; the binary in `~/.agentry/bin` is kept.
- A place of this kind cannot reset a sandbox. GPUs are shared (`CUDA_VISIBLE_DEVICES` narrows what a sandbox sees).
- **Real-machine check (not covered by the tests):** sudo relaying signals, `use_pty`/`requiretty` in sudoers, `pkill`/`pgrep` availability, `ss` output and iptables-nft behaviour.

## E2B places

A place of kind "E2B (hosted)" runs sandboxes on [E2B](https://e2b.dev)'s hosted sandboxes instead of a machine you run. Add it on the admin page with an E2B API key and a template (an E2B template id or name, default `base`; E2B uses templates, so a sandbox template's `image` is refused). The key is stored encrypted and never returned.

- **Pause, not kill:** sandboxes are created with auto-pause. When E2B's timeout (`timeout_s`, default 3600) runs out the sandbox is paused with its files and memory kept, and the next request resumes it. While a sandbox is in use the service keeps pushing the timeout out. Stop pauses, start resumes, delete kills.
- **Reach:** envd is reached through E2B's shared sandbox host (`https://sandbox.e2b.app`) with the sandbox id and E2B's per-sandbox access token as headers. The token is kept sealed apart from the sandbox record and is never returned to a client.
- **Reset deletes all files:** E2B cannot keep a workspace across a reset (the sandbox is killed and a new one made), so a reset that asks to keep files answers 400 `invalid_request`; reset with `keep_workspace: false`. The place's `capabilities.keepFilesOnReset` is `false`.
- **Status is cached 15 s:** a relayed request does not ask E2B for the sandbox's state each time, so a sandbox E2B paused on its own is noticed up to 15 s late (the next call then resumes it). A 429, outage or timeout from E2B while starting answers 503 `place_unavailable` and leaves the sandbox as it was (not failed).
- **Changing the address:** an admin save that changes `api_url` or `sandbox_host` must send the API key again.
- **Limits are E2B's:** for example 10 running sandboxes on the Hobby plan; set the place's "most sandboxes running at once" to mirror them. A 429 from E2B surfaces as an error with its `Retry-After`; nothing retries in a loop.
- **Not available:** GPUs and CPU/memory settings (they come from the E2B template), and no host key to confirm. The shared setup copies DSH's runtime through envd, so the template must be Debian-like with glibc on amd64 (E2B's default is).
- `config`: `template`, optional `timeout_s`, `api_url`, `sandbox_host`; secret `api_key`.

## Third-party

`envd` and its API spec (`third_party/envd/`) come from [e2b-dev/runtime](https://github.com/e2b-dev/runtime) under the Apache License 2.0, unmodified; see `third_party/envd/LICENSE` and `NOTICE.md`.
