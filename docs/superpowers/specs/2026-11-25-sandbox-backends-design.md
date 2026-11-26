# Agentry Sandbox: many places to run (backends) — design

Status: draft for approval · 2026-11-25 · repo `agentry-sandbox` (with small follow-ups in `dsh-agents-api` and `agentry-web`)

## Intent

Agentry should run sandboxes wherever the compute is — the local PC's Docker, a big server, a
GPU box, a hosted sandbox provider, later Kubernetes — and grow from one to the next without
changing how the API or the web app work. The operator (today: the owner of the deployment)
configures the places; users pick one when they create a sandbox or a template.

Why: flexibility. Big machines and GPUs (a remote server, or the operator's own PC with its GPU)
are the immediate need; Kubernetes is the next likely place; local Docker stays.

## Goals

- **One service, many places.** agentry-sandbox keeps one API, one key, one relay. Inside it,
  several *places* (configured backends) are active at once; every sandbox records which place
  it runs on; Docker on the local host stays the default.
- **A new kind of place is a small driver.** What is the same everywhere (getting envd and DSH's
  helper onto a machine, the `agent` user, template provisioning, tokens, health) is written once.
- **GPU as a capability.** Templates can ask for GPUs; places say whether and how many they offer;
  a GPU sandbox only runs where GPUs are offered.
- **Kinds, in build order:** (1) the place registry and shared layer, (2) Docker on a remote host
  over SSH, with GPUs (also local Docker with GPUs), (3) SSH machine, (4) E2B, (5) Kubernetes,
  (6) other providers (Daytona, Modal, …).

## Non-goals (this design)

- Per-user places or keys ("bring your own machine"). Places are operator-configured. Records are
  shaped so an `owner` can be added to a place later without a migration of sandboxes.
- Kubernetes and other providers beyond E2B are outlined only (§ Later kinds); each gets its own
  plan when its turn comes.
- Moving a sandbox between places. A sandbox lives and dies on one place.

## Anti-goals (would make this a failure even if it works)

- Provider credentials or SSH private keys leaving agentry-sandbox (to the API, the web app, the
  browser, logs, or a sandbox).
- A sandbox on a shared Docker host that can reach the host, the LAN or other sandboxes — the
  Docker hardening and network guard must hold on remote hosts as they do locally.
- Silently trusting a new SSH host key (host keys are pinned when a place is added).
- Four slightly different provisioning paths (the reason for the shared layer).

## Approaches considered

| | Approach | Trade-off | |
|---|---|---|---|
| **A** | **Split each backend into a driver (lifecycle, run a command, copy a file, reach a port, capabilities) and one shared layer (envd + helper bootstrap, agent user, provisioning, tokens, health).** | Reworks today's Docker backend first (its tests are the safety net); afterwards every kind is a small driver and every sandbox is set up the same way. | **Chosen.** |
| B | Keep each backend complete on its own (Docker as today; each new kind copies its setup code). | Fastest second backend; by the fourth, divergent provisioning paths. Works against "flexible". | Rejected. |
| C | Everything through SSH (one driver; places must expose SSH; Agentry only connects). | Simplest; cannot create/delete machines (no fresh sandbox per chat, no Reset); E2B/Modal-style providers don't fit. | Rejected (SSH survives as one kind, § SSH machine). |

## Decided with the operator

- Approach A, inside the one agentry-sandbox service (no second service).
- Places are configured by the operator (service config / admin page); users only choose.
- Big machines: **both** "many isolated sandboxes on a remote Docker host" and "work directly on a
  machine over SSH"; either may have GPUs, and the operator's own PC may be such a host.
- Build order as in Goals.

## Today (what changes)

- `src/main.ts` builds exactly one backend (`createDockerBackend`); `createSandboxService` takes
  one `backend`. `SandboxRecord.backend` stores the kind (`docker`).
- `src/backends/docker.ts` does three jobs in one piece: container lifecycle; injecting envd
  (`envdArchive` → `/opt/agentry/envd`) and DSH's runtime (`treeArchive` → `/opt/agentry/dsh`),
  starting envd, `/init`, provisioning (agent user, packages, files, setup commands); reaching
  envd (`endpoint`: published loopback port or container IP).
- `GET /v1/backends` already returns a list (`WireBackend[]`), but the API reads only the first
  (`dsh-agents-api/src/sandbox/agentry-sandbox-provider.ts`: `const [backend] = await … backends()`).
- The envd relay (`src/http/relay.ts`) forwards to `service.endpoint(owner,id)` → `{ baseUrl, token }`
  and sets `X-Envd-User` as Basic auth (envd runs processes as that Unix user).
- Settings (limits) are stored in the `settings` table and edited on the admin page.

## Design

### Vocabulary

- **Kind** — a driver implementation: `docker`, `ssh-machine`, `e2b`, later `kubernetes`, …
- **Place** — a configured instance of a kind, with an id, a display name, its settings and
  secrets: "Local Docker" (kind `docker`, local socket), "Big server" (kind `docker`, `ssh://…`),
  "My GPU box" (kind `ssh-machine`), "E2B" (kind `e2b`).

### Driver contract

A driver owns only what differs per kind:

```ts
interface Driver {
  kind: string
  capabilities: Capabilities                 // see below; may be refined by probe()
  probe(): Promise<Availability & { gpus?: GpuInfo }>   // reachable? version, GPUs found
  // Lifecycle. `machine` is the driver's handle (container id, ssh session, provider sandbox id).
  create(id, owner, spec): Promise<Handle>    // make the machine (or claim a slot on it); not provisioned yet
  start(id, handle, spec): Promise<Handle>    // make it run; resolves when commands can run
  stop(handle): Promise<void>
  destroy(id, handle, opts: { keepWorkspace }): Promise<void>
  status(handle): Promise<'running' | 'stopped' | 'missing'>
  listManaged(): Promise<{ id, owner, handle }[]>        // reconciliation (as today)
  // What the shared layer needs to bootstrap envd. Drivers whose machines already run envd
  // (E2B) set capabilities.envdBuiltIn and may leave exec/putFiles unimplemented.
  exec?(handle, argv: string[], opts: { user?: 'root' | 'login' }): Promise<{ code, stdout, stderr }>
  putFiles?(handle, tar: Buffer, dest: string): Promise<void>
  // Where envd answers, reachable from this service (a tunnel when the machine is remote).
  envdEndpoint(handle): Promise<{ baseUrl: string; release?: () => void }>
  maintain?(id, handle, spec): Promise<void>  // e.g. Docker re-applies network rules
  releaseOwner?(owner): Promise<void>
}

interface Capabilities {
  persistent: boolean        // files survive stop/start
  reset: boolean             // can be wiped and re-provisioned
  isolated: boolean          // separate from the host and other sandboxes (false for ssh-machine)
  network: boolean           // honours `network: false`
  resources: boolean         // honours cpus/memory
  gpu: boolean               // can attach GPUs (see GPU)
  envdBuiltIn: boolean       // envd already runs on the machine (E2B)
  runsAsRoot: boolean        // envd runs as root and can switch users (false for ssh-machine)
  templateFields: (keyof TemplateSpec)[]
}
```

### Shared layer (the "bootstrap")

Generalises what `docker.ts` does today, in one module used by every driver:

1. `driver.start()` → machine runs.
2. Unless `envdBuiltIn`: `putFiles` the envd binary (per architecture, § envd binaries) to
   `/opt/agentry/envd`, start it (`exec`, detached, listening on loopback), wait for health via
   `envdEndpoint`.
3. `/init` envd with the per-sandbox token (`HMAC(secret, id)`, as today), first as root when
   `runsAsRoot`.
4. On first start only: create the `agent` user (when `runsAsRoot`), install template packages,
   write template files, run setup commands — the current `provision()` — then `/init` as `agent`.
5. Copy DSH's runtime to `/opt/agentry/dsh` once per machine image/version, **through envd**
   (upload + extract), so drivers without a `putFiles` (E2B) still get it.

The relay is unchanged except that `service.endpoint()` asks the sandbox's place for
`envdEndpoint` (and holds the tunnel while a request streams).

### Place registry and storage

- New table `places` (migration `0003_places.sql`): `id`, `name`, `kind`, `config` (JSON, no
  secrets), `secrets` (encrypted JSON: SSH private key, provider API key; AES-256-GCM with a key
  derived from `AGENTRY_SANDBOX_SECRET` by HKDF, info `agentry-sandbox places`), `enabled`,
  `is_default`, `created_at`, `updated_at`.
- A built-in place **"Local Docker"** (id `local`, kind `docker`) is always present from the
  environment variables as today, so an existing install keeps working with no admin action and
  every existing sandbox maps to it (migration sets `backend = 'local'` where it was `docker`).
- `SandboxRecord.backend` holds the **place id**. Templates get an optional `place` (id) and
  `gpus`; a sandbox without a place uses the template's, else the default place.
- Admin page: a "Places" section — list (kind, state from `probe`, GPUs found, sandbox count),
  add / edit / disable / delete (delete only when it has no sandboxes), test connection. Secrets
  are write-only (never returned). Per-place optional `maxRunning` on top of the existing limits.
- Admin API: `GET/POST /v1/admin/places`, `GET/PUT/DELETE /v1/admin/places/{id}`,
  `POST /v1/admin/places/{id}/test`.

### Public API changes

- `GET /v1/backends` → every enabled place: `{ id, name, kind, available, reason?, version?,
  default, capabilities, gpus?: { count, model? }, default_image? }`. (`kind` stays for clients that
  read it; `id` is new.)
- `POST /v1/sandboxes` and templates accept `place` (id) and `gpus` (`0` default, a count, or
  `"all"`). Asking for GPUs on a place without them, or a template field the place does not
  support, answers 400 naming the field (as unsupported template fields do today).
- `WireSandbox` gains `place` (id) and `gpus`.

### Kind: Docker (local or remote over SSH), with GPUs

- Today's backend becomes the `docker` driver; behaviour and hardening unchanged.
- Remote hosts: place config `{ host: "ssh://user@server", sshKey (secret), hostKey (pinned) }`.
  Docker API calls go over SSH (dockerode/docker-modem `protocol: 'ssh'`, or an ssh2 stream to the
  remote `docker.sock`). envd is published on the **remote host's** loopback; the service reaches it
  with an SSH local forward held per sandbox while in use (`envdEndpoint` returns
  `http://127.0.0.1:<local port>` and a `release`).
- The network guard (`netguard`) runs its helper container through the same Docker connection, so
  its rules land on the remote host. The remote host needs the `agentry/*` images (or pulls them).
- GPUs: `gpus` in the spec → `HostConfig.DeviceRequests = [{ Driver: 'nvidia', Count, Capabilities:
  [['gpu']] }]`. `probe()` reports GPUs when the daemon lists the `nvidia` runtime (and optionally
  `nvidia-smi` through a throwaway container). Applies to local Docker too (the operator's PC).

### Kind: SSH machine (work directly on an existing box)

*Revised 2026-11-25 after a spike: unmodified envd cannot start any process unless it runs as root
(it always switches credentials; as a normal user every command fails with `fork/exec /bin/sh:
operation not permitted`). The operator chose to run envd with passwordless sudo (option A); a
patched envd for machines without sudo is on the operator's personal backlog.*

- Place kind `ssh-machine`. Config `{ url: 'ssh://user@host[:port]', host_key }`, secrets
  `{ private_key }` (the same shape and admin flow as `docker-ssh`).
- Requirements on the machine: Linux (x86_64 or aarch64), glibc, and **passwordless sudo** for the
  login user (`probe` checks `sudo -n true` and reports "passwordless sudo is required" otherwise).
- Capabilities: `persistent: true`, `reset: false`, `isolated: false`, `network: false`,
  `resources: false`, `envdBuiltIn: false`, `runsAsRoot: true`, `gpu` from `nvidia-smi` on the
  machine; template fields `setupCommands`, `env`, `files`, `gpus` only (no images, no system
  packages: it is the operator's own machine).
- **The agent runs as the login user**, never as a created `agent` user: the shared bootstrap does
  not create users or sudoers entries on this kind; the relay maps a requested `X-Envd-User` of
  `agent` to the login user (`root` stays root, which that user can reach with sudo anyway).
- `create`/`start`: over SSH, upload envd for the machine's architecture to
  `~/.agentry/bin/envd-<version>-<arch>` (skipped when the sha256 matches), create the sandbox's
  workspace (the API's path, `sudo -n mkdir -p` + `chown` to the login user), pick a free loopback
  port, and start envd detached with `sudo -n` on `127.0.0.1:<port>`, recording
  `~/.agentry/sandboxes/<id>/{meta.json,envd.pid,envd.log}`; reach it through an SSH tunnel.
  envd has no listen-address flag, so before starting it the driver adds sudo `iptables`/`ip6tables`
  rules dropping that port on every interface but loopback (fail closed: no rule, no envd); the
  tunnel arrives on loopback.
  DSH's runtime for that architecture is copied by the shared bootstrap as everywhere else.
- `stop` kills that envd; `destroy` stops it and removes exactly the recorded workspace directory
  and `~/.agentry/sandboxes/<id>/` (never anything else); `status` is "running" when the pid is alive
  and envd answers through the tunnel; `listManaged` reads the `meta.json` files.
- GPUs: exclusive like everywhere (§ GPU sharing); the assignment reaches the agent as
  `CUDA_VISIBLE_DEVICES=<uuids>` in envd's environment (a convention: the login user can still see
  every GPU).
- envd and DSH's runtime for the machine's architecture come from their multi-arch images, read
  through the service host's local Docker with an explicit platform.
- Admin page warning: agents get the login user's full access (and its sudo) on that machine; there
  is no isolation between sandboxes on it.

### Kind: E2B

- Place config `{ apiKey (secret), template (E2B template id/alias), domain? }`.
  `envdBuiltIn: true`; `create`/`start` via E2B's API (create, then pause/resume where E2B supports
  it for `persistent`, else `persistent: false`); `envdEndpoint` is E2B's envd URL for the sandbox
  with its access token (the relay sends E2B's token instead of the HMAC one; stored in the handle,
  encrypted).
- Templates on E2B use E2B template ids (a Docker `image` is not accepted — 400 naming the field).
  DSH's runtime is copied through envd on first start (shared layer step 5).
- Network rules and resources are E2B's; capabilities say so.

### Later kinds (outline only)

- **Kubernetes:** a pod per sandbox (image, resources, `nvidia.com/gpu` limits, a PVC for
  `persistent`), envd copied with an exec'd `tar` (or an init container), reached with the
  Kubernetes port-forward API; network isolation via NetworkPolicy. Config: kubeconfig (secret),
  namespace, storage class.
- **Other providers (Daytona, Modal, …):** a driver per provider using its create/exec/port APIs
  with the shared bootstrap, or the SSH-machine driver where the provider hands out SSH access.

### envd binaries

The `agentry/envd` image builds envd for one architecture today. The service needs envd for each
target architecture (amd64, arm64): build both in `images/envd` and pick by `uname -m` from the
driver's `exec` (Docker containers: the image's architecture).

### API and web app (follow-ups in the other repos)

- **dsh-agents-api:** read all places from `backends()` (not just the first); the providers
  endpoint lists them under the `sandbox` provider with name, availability and GPUs; environment
  create and templates pass `place` and `gpus`; `describe` shows the place.
- **agentry-web:** "Runs on" lists places (name, kind in plain words, availability, GPU count);
  the template editor gets a place selector and a GPU field; the environment detail shows the
  place; places without Reset hide the Reset action; SSH-machine places carry the "no isolation"
  note.

## Builder's questions, settled (designer's calls unless marked)

1. **Scope of the first plan.** The contract and storage are designed for every kind now. The first
   plan builds: the place registry and admin UI, the shared layer (Docker split), remote Docker over
   SSH, GPUs on Docker, and the API/web follow-ups (listing and choosing places, GPUs) once. The
   SSH-machine kind and E2B are the second and third plans; each may extend the shared layer within
   this contract (optional `exec`/`putFiles`, non-root envd, driver-supplied token).
2. **envd token and secrets in the handle.** `envdEndpoint(handle)` returns `{ baseUrl, token?,
   release? }`; the service uses the driver's `token` when given (E2B) and the HMAC token otherwise.
   Secret handle values live in a new encrypted column `sandboxes.handle_secrets` (same key as
   places' secrets); `handle` stays plain JSON. For SSH forwards the service listens on an ephemeral
   loopback port (`listen(0)`) per forward; the remote side is the container's published loopback
   port (remote Docker) or envd's remote port (SSH machine).
3. **Unavailable, disabled and deleted places.** Reconciliation and the idle sweep run per place
   and skip a place whose `probe` fails: its sandboxes are never marked missing or destroyed because
   the place is unreachable. Calls to an unreachable place answer 503 `place_unavailable` naming the
   place (`BackendUnavailableError` becomes per place). A disabled place accepts no create or start;
   its sandboxes can still be stopped and deleted. A place with sandboxes cannot be deleted.
4. **Images and envd binaries.** The `agentry/*` images (envd, dsh-runtime, sandbox, netguard) are
   published to GHCR as multi-arch (amd64, arm64) images by agentry-sandbox CI, the same way the
   other repos publish; remote Docker hosts pull them by name. The service image carries envd for
   both architectures (and DSH's runtime tree) as files, so SSH machines and E2B need no Docker on
   the service host to get them. Local development may keep building them with `pnpm images:build`.
5. **SSH host keys.** `POST /v1/admin/places/{id}/test` (or a test on an unsaved draft) connects,
   and returns the host key fingerprint without trusting it; the admin confirms and the place is
   saved with `hostKey`. Every later connection requires that exact key; a change fails hard
   (`place_host_key_changed`) until an admin re-confirms on the admin page.
6. **The built-in "Local Docker" place** (id `local`): always present, configured from the
   environment, cannot be deleted; it can be renamed, disabled, and made non-default.
   `GET /v1/backends` lists the default place first, so clients that read only the first entry keep
   getting the default. Existing records migrate `backend = 'docker'` → `'local'`; the API does not
   compare that field to `docker`.
7. **SSH machine over time.** One envd per sandbox, each on its own remote loopback port with its
   own per-sandbox token, tracked by a pidfile and port in `~/.agentry/sandboxes/<id>/` on the
   machine. `status` is "running" only when the pid is alive and envd answers health through the
   forward; after a reboot or a dropped link, `start` relaunches it. The relay rewrites any
   requested `X-Envd-User` to the login user for this kind (so files are owned by and processes run
   as that user, and the sandbox reports that user).
8. **Limits per place.** A place's optional `maxRunning` applies on top of the global and per-owner
   limits. GPUs: see § GPU sharing (operator's decision).

### GPU sharing (decided by the operator: exclusive)

- GPUs are handed out like seats, per place. A running sandbox that asked for `n` GPUs holds `n`
  specific GPUs (by index/UUID from `probe`) until it stops; nothing else is given them meanwhile.
  `"all"` takes every GPU of the place and needs all of them free.
- Assignment happens at `start` (not `create`): stopped sandboxes hold no GPUs. When too few are
  free, `start` answers 409 `gpu_unavailable` naming the place and how many are free; there is no
  queue in this design (the agent or user retries).
- Docker passes the assigned devices (`DeviceRequests` with `DeviceIDs`, not `Count`). SSH machines
  export `CUDA_VISIBLE_DEVICES` with the assigned indices in envd's environment (a convention, not
  enforcement: the login user can still see every GPU).
- Assignments are recorded on the sandbox (`gpu_ids`) so a service restart rebuilds the table from
  running sandboxes; reconciliation frees the GPUs of sandboxes that are gone.
- A per-place "share GPUs" switch can come later without changing records.

## Constraints

- Hardening of Docker sandboxes (capabilities, seccomp, no privileged, network guard) is the same
  on remote Docker hosts.
- SSH: key auth only, pinned host key (shown for confirmation when the place is added), no agent
  forwarding.
- Secrets encrypted at rest with a key derived from `AGENTRY_SANDBOX_SECRET` (rotating that
  secret already invalidates envd tokens; places' secrets must then be re-entered — the admin page
  says so).
- Existing installs keep working with no configuration change (built-in "Local Docker" place).
- Tests: the existing Docker backend tests must pass unchanged in behaviour after the split; each
  driver gets unit tests against fakes (the repo already has `backends/fake.ts`), and live tests
  gated by env (remote Docker host, SSH machine, E2B key) like the current Docker integration tests.

## Left to the builder

- Module layout, names, and how the shared layer is split into files.
- SSH library choice (ssh2 is the natural one) and tunnel pooling.
- Exact admin page layout within its current one-page style.
- How `probe()` caches results and how often the admin page refreshes them.
- Whether DSH's runtime copy uses envd's file upload plus `tar -x`, or per-file writes.
