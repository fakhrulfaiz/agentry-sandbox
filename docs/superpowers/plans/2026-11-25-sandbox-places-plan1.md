# Sandbox places, plan 1: registry, shared layer, remote Docker over SSH, exclusive GPUs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agentry-sandbox runs sandboxes on several configured *places* at once (local Docker, Docker on a remote host over SSH), with exclusive GPU assignment, its images on GHCR, and the Agentry API and web app able to list and choose places and ask for GPUs.

**Architecture:** The single `Backend` becomes a per-place `Driver` plus a shared bootstrap (envd `/init`, provisioning, DSH runtime copy). A `PlaceRegistry` holds the built-in "Local Docker" place and admin-added places (stored in Postgres, secrets encrypted). The sandbox service routes every call through the sandbox's place. Remote Docker uses dockerode over SSH with a pinned host key and per-sandbox SSH tunnels to envd.

**Tech Stack:** Node 24, TypeScript, dockerode 4 (ssh protocol), ssh2, pg, vitest; GitHub Actions + GHCR; dsh-agents-api (TypeScript, DSH plugin); agentry-web (Next.js 16, astryx, StyleX).

**Spec:** `docs/superpowers/specs/2026-11-25-sandbox-backends-design.md` (same repo). This plan covers the spec's first plan (§ Builder's questions 1). SSH machine (plan 2) and E2B (plan 3) are out of scope; the contract below leaves room for them.

## Global Constraints

- Commits as `fakhrulfaiz <fakhrulfaiz2003@gmail.com>`; never add `Co-Authored-By` or any AI attribution (commits, PRs, comments).
- Shell PATH: `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH` (the default `pnpm` is a Windows binary).
- agentry-sandbox: `pnpm typecheck`, `pnpm test`. Docker integration suites skip when no daemon answers (`tests/support/docker.ts`); remote/SSH suites skip unless their env vars are set.
- Existing installs keep working with no configuration change: built-in place id `local`, kind `docker`, configured from today's environment variables.
- Secrets (SSH private keys) never leave agentry-sandbox: never in responses, logs, errors, or the API/web.
- SSH: key auth only, pinned host key (`sha256:` fingerprint, OpenSSH format `SHA256:<base64>` accepted and normalised), no agent forwarding; a changed key fails with `place_host_key_changed`.
- Secret encryption: AES-256-GCM, key = HKDF-SHA256(`AGENTRY_SANDBOX_SECRET`, salt `agentry-sandbox`, info `agentry-sandbox places`, 32 bytes).
- Docker sandbox hardening (CapDrop ALL + CAP_ADD list, no privileged, pids/cpu/memory limits, network guard) is identical on remote hosts.
- Image names become `ghcr.io/fakhrulfaiz/agentry-envd:envd-v0.6.13`, `ghcr.io/fakhrulfaiz/agentry-dsh-runtime:0.2.2-rc.1`, `ghcr.io/fakhrulfaiz/agentry-sandbox:1`, `ghcr.io/fakhrulfaiz/agentry-netguard:1` (defaults in `src/config.ts`; env overrides unchanged).
- Error codes (new): 503 `place_unavailable`, 409 `gpu_unavailable`, 409 `place_disabled`, 409 `place_in_use`, 409 `place_host_key_changed`, 400 `invalid_request` for unknown place / unsupported field.
- Every repo's CHANGELOG gets a dated entry with each behaviour change (agentry-web and dsh-agents-api require it).

## Review Focus

1. **A remote place is down when the service starts or sweeps** → the local place still reconciles and serves; the remote place's sandboxes are not marked failed/missing (Task 3 test `reconcile skips an unavailable place`).
2. **Two starts asking for GPUs race on one place** → each gets distinct GPUs or `gpu_unavailable`; never the same GPU twice (Task 7 test `concurrent starts never share a GPU`).
3. **Upgrade of an existing install** → records with `backend = 'docker'` become `local` and start/stop/delete as before (Task 1 migration test + Task 3 test `pre-upgrade sandbox still starts`).
4. **The SSH tunnel drops during a relayed request** → that request answers 502 `envd_unreachable`; the next request opens a new tunnel and works (Task 6 test `a dropped tunnel is reopened`).
5. **The remote host's key changes** → every call to that place fails with `place_host_key_changed` and nothing is sent over the connection (Task 6 test `refuses a changed host key`).

---

### Task 1: Encrypted secrets, places storage, migration

**Files:**
- Create: `src/crypto/secrets.ts`, `migrations/0003_places.sql`
- Modify: `src/store/types.ts`, `src/store/memory.ts`, `src/store/postgres.ts`
- Test: `tests/secrets.spec.ts`, `tests/store-contract.ts` (+ runs via `store-memory.spec.ts` / `store-postgres.spec.ts`)

**Interfaces:**
- Produces:
  - `sealSecrets(secret: string, value: Record<string, string>): string` and `openSecrets(secret: string, sealed: string): Record<string, string>` (base64 of `iv(12) | tag(16) | ciphertext`; throws `SecretsError` on tamper / wrong key).
  - `interface PlaceRecord { id: string; name: string; kind: string; config: Record<string, unknown>; secrets: string | null /* sealed */; enabled: boolean; isDefault: boolean; maxRunning: number | null; gpus: GpuInfo[] | null; createdAt: number; updatedAt: number }`
  - `interface GpuInfo { index: number; uuid: string; name: string }`
  - `Store.places: { list(): Promise<PlaceRecord[]>; get(id): Promise<PlaceRecord | undefined>; insert(r): Promise<void>; update(id, patch: Partial<Omit<PlaceRecord,'id'|'createdAt'>>): Promise<PlaceRecord | undefined>; delete(id): Promise<boolean> }`
  - `SandboxRecord.handleSecrets: string | null` (sealed), `SandboxPatch` includes it.
  - `TemplateSpec.place?: string`, `TemplateSpec.gpus?: number | 'all'`.

- [ ] **Step 1: Write failing tests** — `tests/secrets.spec.ts`: `seal/open round-trips`, `a flipped byte throws SecretsError`, `another secret cannot open it`, `two seals of the same value differ (random iv)`. Store contract: `places CRUD round-trips config and sealed secrets`, `only one place isDefault after update sets another default` (the store clears the old default in the same call), `sandbox handleSecrets round-trips`. Postgres-only: `migration 0003 maps backend docker to local` (insert a row with `backend='docker'` before migrating 0003, expect `local` after).
- [ ] **Step 2: Run** `pnpm test tests/secrets.spec.ts tests/store-memory.spec.ts` — Expected: FAIL (modules/fields missing).
- [ ] **Step 3: Implement** `src/crypto/secrets.ts` (node:crypto `hkdfSync`, `createCipheriv('aes-256-gcm')`); `0003_places.sql`: `create table places (id text primary key, name text not null, kind text not null, config jsonb not null default '{}', secrets text, enabled boolean not null default true, is_default boolean not null default false, max_running integer, gpus jsonb, created_at timestamptz not null, updated_at timestamptz not null)`, a partial unique index `on places (is_default) where is_default`, `alter table sandboxes add column handle_secrets text`, `update sandboxes set backend = 'local' where backend = 'docker'`; memory and postgres stores implement `places` and `handleSecrets`.
- [ ] **Step 4: Run** `pnpm test` — Expected: PASS (postgres suite runs when its DB env is set, as today).
- [ ] **Step 5: Commit** `feat: encrypted place storage and the places table`

### Task 2: Driver contract and shared bootstrap (Docker split)

**Files:**
- Create: `src/places/driver.ts` (contract), `src/places/bootstrap.ts` (shared layer), `src/places/drivers/docker.ts` (moved from `src/backends/docker.ts`), `src/places/drivers/fake.ts` (moved from `src/backends/fake.ts`)
- Modify: `src/backends/types.ts` → re-export from `src/places/driver.ts` for one release (keeps `@agentry/sandbox/testing` importers compiling), `src/testing.ts`, `src/backends/envd-binary.ts` (unchanged API), `src/backends/network-guard.ts` (unchanged)
- Test: `tests/docker-backend.spec.ts` → `tests/docker-driver.spec.ts` (same cases), `tests/bootstrap.spec.ts`

**Interfaces:**
- Produces (`src/places/driver.ts`):
  ```ts
  export type Handle = Record<string, string>
  export interface Capabilities { persistent: boolean; reset: boolean; isolated: boolean; network: boolean; resources: boolean; gpu: boolean; envdBuiltIn: boolean; runsAsRoot: boolean; templateFields: (keyof TemplateSpec)[] }
  export interface Driver {
    kind: string
    capabilities: Capabilities
    probe(): Promise<Availability & { gpus?: GpuInfo[] }>
    describeImage?(image: string): Promise<ImageInfo | undefined>
    create(id: string, owner: string, spec: TemplateSpec, ctx: StartContext): Promise<Handle>   // machine made AND envd reachable; not provisioned
    start(id: string, handle: Handle, spec: TemplateSpec, ctx: StartContext): Promise<Handle>   // envd reachable
    stop(handle: Handle): Promise<void>
    destroy(id: string, handle: Handle, opts: { keepWorkspace: boolean }): Promise<void>
    status(handle: Handle): Promise<'running' | 'stopped' | 'missing'>
    envdEndpoint(handle: Handle): Promise<{ baseUrl: string; token?: string; release?: () => void }>
    listManaged(): Promise<{ id: string; owner: string; handle: Handle }[]>
    maintain?(id: string, handle: Handle, spec: TemplateSpec): Promise<void>
    releaseOwner?(owner: string): Promise<void>
    close?(): Promise<void>
  }
  export interface StartContext { gpuIds: string[] /* assigned GPU uuids, [] when none */ }
  ```
  `Availability` and `ImageInfo` keep their current shapes.
- Produces (`src/places/bootstrap.ts`): `bootstrap(driver: Driver, id: string, handle: Handle, spec: TemplateSpec, opts: { secret: string; dshRuntime: (() => Promise<Buffer>) | null; startTimeoutMs: number }): Promise<Handle>` — waits for envd health via `envdEndpoint`, `/init` (root first when `runsAsRoot` and `handle.provisioned !== 'true'`), runs the current `provision()` steps (agent user, packages, files, setup commands) on first start, copies DSH's runtime tar **through envd** to `/opt/agentry/dsh` when `handle.dsh !== <runtime image ref>`, `/init` as `agent`, returns the handle with `provisioned: 'true'` and `dsh: <ref>`.
- The Docker driver keeps envd placement (putArchive of envd, container entrypoint) and no longer provisions; `create`/`start` return once the container runs.

- [ ] **Step 1: Write failing tests** — `tests/bootstrap.spec.ts` against `tests/support/bare-envd.ts`: `first start creates agent, installs packages, writes files, runs setup in order`, `second start only inits as agent`, `a failing setup command rejects with its exit code and stderr tail`, `copies the DSH runtime once per runtime ref` (two bootstraps, one copy). `tests/docker-driver.spec.ts`: every case of today's `docker-backend.spec.ts`, now calling `driver.create` + `bootstrap`.
- [ ] **Step 2: Run** `pnpm test tests/bootstrap.spec.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the contract, `bootstrap.ts` (move `ensureAgent`, `installScript`, `provision` from docker.ts unchanged; DSH runtime copy = envd file upload of the tar to `/tmp/agentry-dsh.tar` then `tar -xf … -C /opt/agentry && rm`), the Docker driver (lifecycle + envd placement + `probe` = `client.version()` + GPU probe stub returning `[]` until Task 7), the fake driver (same knobs as `FakeBackend`, plus `setGpus(gpus)` and `calls` entries for `bootstrap` steps).
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS, including the Docker integration suite when Docker is up.
- [ ] **Step 5: Commit** `refactor: split the Docker backend into a driver and a shared bootstrap`

### Task 3: Place registry and multi-place sandbox service

**Files:**
- Create: `src/places/registry.ts`
- Modify: `src/sandboxes.ts`, `src/main.ts`, `src/testing.ts`, `src/config.ts` (image defaults from Global Constraints)
- Test: `tests/sandboxes.spec.ts`, `tests/registry.spec.ts`

**Interfaces:**
- Consumes: Task 1 `Store.places`, `sealSecrets/openSecrets`; Task 2 `Driver`, `bootstrap`.
- Produces (`src/places/registry.ts`):
  ```ts
  export interface Place { id: string; name: string; kind: string; enabled: boolean; isDefault: boolean; maxRunning: number | null; driver: Driver; gpus: GpuInfo[] }
  export interface PlaceRegistry {
    list(): Place[]                       // default first, then by name
    get(id: string): Place | undefined
    default(): Place
    reload(): Promise<void>               // after admin edits
    makeDriver: (record: PlaceRecord, secrets: Record<string, string>) => Driver   // injected per kind
  }
  export function createPlaceRegistry(deps: { store: Store; config: SandboxConfig; local: Driver; drivers: Record<string, (r: PlaceRecord, secrets: Record<string, string>) => Driver> }): Promise<PlaceRegistry>
  export const LOCAL_PLACE_ID = 'local'
  ```
  The `local` place always exists (name `Local Docker` unless the admin renamed it via a stored record with id `local`; a stored `local` record may change `name`, `enabled`, `isDefault`, `maxRunning`, never `kind` or be deleted).
- Produces (`src/sandboxes.ts`): `createSandboxService(deps: { store: Store; places: PlaceRegistry; config: SandboxConfig; now?: () => number })`; `CreateSandbox` gains `place?: string`, `gpus?: number | 'all'`; new errors `PlaceUnavailableError(placeName, reason)` (→ 503 `place_unavailable`), `PlaceDisabledError` (→ 409 `place_disabled`); `BackendUnavailableError` is kept as an alias of `PlaceUnavailableError` for the API client; `endpoint(owner, id)` returns `{ baseUrl, token, release? }` (token = driver's when given, else HMAC).
- Place resolution on create: `input.place ?? template.place ?? places.default().id`; unknown id → `invalid_request` "no place '<id>'"; a template field outside `place.driver.capabilities.templateFields` → `invalid_request` naming it; `gpus > 0` on a place without `capabilities.gpu` → `invalid_request` "place '<name>' has no GPUs".
- Limits: a place's `maxRunning` counts its running sandboxes, checked with the existing running limits.

- [ ] **Step 1: Write failing tests** (fake drivers for two places `local` and `remote`): `create uses input.place, then template.place, then the default`, `a disabled place refuses create and start (place_disabled) but allows stop and delete`, `reconcile skips an unavailable place` (remote `probe` fails: its running record stays `running`, local still reconciles), `calls to an unavailable place fail with place_unavailable naming it`, `maxRunning per place is enforced`, `pre-upgrade sandbox still starts` (record `backend: 'local'` made before any place row exists), `endpoint passes the driver token when it gives one`.
- [ ] **Step 2: Run** `pnpm test tests/sandboxes.spec.ts tests/registry.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the registry and route every lifecycle call, the idle sweep, `reconcile` (per place, skip a place whose `probe` is not ok), and `endpoint` through `places.get(record.backend)`; `main.ts` builds the local Docker driver + network guard as today and the registry, then reconciles; `testing.ts` exposes the fake driver as `backend` (unchanged property name) for existing API tests.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: several places per service, each sandbox on its place`

### Task 4: HTTP API — places on the wire, admin places endpoints

**Files:**
- Modify: `src/http/server.ts`, `src/http/relay.ts` (call `release` when the response ends), `src/client/index.ts`, `openapi/agentry-sandbox.yaml`
- Test: `tests/http.spec.ts`, `tests/admin.spec.ts`, `tests/client.spec.ts`, `tests/openapi-drift.spec.ts`

**Interfaces:**
- Consumes: Task 3 registry and service.
- Produces (wire):
  - `GET /v1/backends` → `WireBackend[]` with new `id: string`, `name: string`, `default: boolean`, `gpus?: { count: number; models: string[] }`, `capabilities` (the Task 2 `Capabilities` shape; the old four fields keep their names), default place first; disabled places omitted.
  - `POST /v1/sandboxes` body gains `place?: string`, `template.gpus?`, `template.place?`; `WireSandbox` gains `place: string`, `gpus: number | 'all' | 0`; `WireTemplate` gains `place?`, `gpus?`.
  - Admin: `GET /v1/admin/places` → `{ data: AdminPlace[] }` where `AdminPlace = { id, name, kind, enabled, default, max_running, config, has_secrets: boolean, available, reason?, gpus, sandboxes: number }` (never secrets); `POST /v1/admin/places` `{ name, kind, config, secrets, host_key? }` → 201; `PUT /v1/admin/places/{id}` (fields optional; `secrets` replaces, omitted keeps); `DELETE /v1/admin/places/{id}` → 409 `place_in_use` while it has sandboxes, 400 for `local`; `POST /v1/admin/places/test` `{ kind, config, secrets }` → `{ ok, reason?, host_key?: 'SHA256:…', gpus? }` (connects without trusting the key; used before save and after a key change).
  - Client (`src/client/index.ts`): types above; `create({ …, place? })`.
- [ ] **Step 1: Write failing tests** — `GET /v1/backends lists places default-first with gpus`, `create with an unknown place answers 400 naming it`, `admin create never echoes secrets`, `admin delete of a place with sandboxes answers 409 place_in_use`, `admin cannot delete local`, `the relay releases the tunnel after the response ends` (fake driver counts releases), `openapi lists every new route` (drift test).
- [ ] **Step 2: Run** `pnpm test tests/http.spec.ts tests/admin.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the routes, wire mappers, error mapping (Global Constraints codes), the openapi entries, and the client types.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: places on the HTTP API and the admin places endpoints`

### Task 5: Admin page — Places section

**Files:**
- Modify: `src/admin/index.html`
- Test: `tests/admin.spec.ts` (served page contains the section; no JS test runner for the page today)

- [ ] **Step 1: Write failing test** — `admin page has a Places section and an add-place form with a host key confirmation step` (asserts the served HTML contains `id="places"`, `id="place-form"`, `id="place-hostkey-confirm"`).
- [ ] **Step 2: Run** `pnpm test tests/admin.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** in the page's existing style: a Places table (name, kind in words — "Docker (this machine)", "Docker over SSH" —, state, GPUs, sandboxes, default, enabled; actions: make default, enable/disable, edit, delete) and an add/edit form for kind `docker-ssh` (fields: name, `ssh://user@host[:port]`, private key textarea, max running). "Test connection" calls `POST /v1/admin/places/test`, shows the host key fingerprint and GPUs, and only then enables "Save" (which sends `host_key`). A key-change error on a place shows "Host key changed — test and confirm the new key".
- [ ] **Step 4: Run** `pnpm test` — Expected: PASS. Manually: `bash scripts/dev.sh`, open `/admin`, add a place against an SSH-reachable Docker host if one is available.
- [ ] **Step 5: Commit** `feat: Places section on the admin page`

### Task 6: Remote Docker over SSH

**Files:**
- Create: `src/places/ssh.ts` (connection options, host key check, tunnel manager), `src/places/drivers/docker-ssh.ts`
- Modify: `src/places/drivers/docker.ts` (accept an injected dockerode client and an endpoint strategy), `src/places/registry.ts` (`drivers['docker-ssh']`), `src/main.ts`
- Test: `tests/ssh.spec.ts`, `tests/docker-ssh.live.spec.ts` (skips unless `AGENTRY_SANDBOX_TEST_DOCKER_SSH=ssh://user@host` and `AGENTRY_SANDBOX_TEST_DOCKER_SSH_KEY_FILE` are set)

**Interfaces:**
- Consumes: Task 2 Docker driver, Task 3 registry.
- Produces (`src/places/ssh.ts`):
  - `parseSshTarget(url: string): { host: string; port: number; username: string }` (`ssh://user@host[:port]`, port default 22; rejects anything else).
  - `fingerprint(hostKey: Buffer): string` → `SHA256:<base64 without padding>` (OpenSSH format).
  - `hostVerifier(pinned: string): (key: Buffer) => boolean` and `HostKeyChangedError` (→ 409 `place_host_key_changed`).
  - `createTunnels(opts: { target; privateKey: string; hostKey: string }): { open(remotePort: number): Promise<{ localPort: number; close(): void }>; closeAll(): Promise<void> }` — one ssh2 `Client` per place, re-connected on demand; each `open` listens on `127.0.0.1:0` and `forwardOut`s to `127.0.0.1:<remotePort>` on the host.
- `docker-ssh` place config: `{ target: 'ssh://user@host[:port]' }`; secrets: `{ privateKey }`; record `config.hostKey` (pinned). Driver = the Docker driver with `new Docker({ protocol: 'ssh', host, port, username, sshOptions: { privateKey, hostVerifier, agentForward: false } })` (pull client without timeout likewise), the network guard built on that client, `envdReach: 'loopback'` forced, and `envdEndpoint` = tunnel to the container's published `127.0.0.1` port → `{ baseUrl: 'http://127.0.0.1:<localPort>', release }`.
- [ ] **Step 1: Write failing tests** — `tests/ssh.spec.ts` with an in-process ssh2 `Server` (test host key generated in the test): `parseSshTarget accepts ssh://u@h and ssh://u@h:2222, rejects http://`, `fingerprint matches ssh-keygen format`, `refuses a changed host key` (connect with a different pinned key → `HostKeyChangedError`, server sees no channel open), `forwards a local port to the remote port`, `a dropped tunnel is reopened` (server kills the connection; the next `open` reconnects and forwards).
- [ ] **Step 2: Run** `pnpm test tests/ssh.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `ssh.ts`, the `docker-ssh` driver factory, and its registration; `probe` = `client.version()` over SSH (errors → not ok with the reason; host key mismatch → reason "host key changed").
- [ ] **Step 4: Run** `pnpm test` (live suite skips without its env) — Expected: PASS. If a remote Docker host is available: set the two env vars and run `pnpm test tests/docker-ssh.live.spec.ts` — Expected: create → exec `echo ok` through the relay → stop → start → delete PASS.
- [ ] **Step 5: Commit** `feat: Docker on a remote host over SSH`

### Task 7: Exclusive GPUs on Docker places

**Files:**
- Create: `src/places/gpus.ts`
- Modify: `src/places/drivers/docker.ts` (GPU probe, `DeviceRequests`), `src/sandboxes.ts` (assignment at start), `src/places/registry.ts` (store probed GPUs on the place)
- Test: `tests/gpus.spec.ts`, `tests/sandboxes.spec.ts`

**Interfaces:**
- Produces (`src/places/gpus.ts`): `assignGpus(free: GpuInfo[], want: number | 'all', total: number): GpuInfo[] | undefined` (lowest indices first; `'all'` needs every GPU free; `undefined` when too few).
- Service: before `driver.start`/`create`, under a per-place lock, free = place GPUs minus those held by its running/provisioning sandboxes (`handle.gpuIds`, comma-separated uuids); none → 409 `gpu_unavailable` "place '<name>' has <n> of <total> GPUs free"; the assignment is written to `handle.gpuIds` and passed in `StartContext.gpuIds`; `stop`, `destroy` and a failed start release them (clear `handle.gpuIds`).
- Docker: `probe` lists GPUs when `client.info().Runtimes` has `nvidia`, by running a throwaway container (`HostConfig.DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu', 'utility']] }]`, image = the place's default image, cmd `nvidia-smi --query-gpu=index,uuid,name --format=csv,noheader`), parsed into `GpuInfo[]`; no runtime → `[]`. Container create with `gpuIds.length > 0` sets `DeviceRequests: [{ Driver: 'nvidia', DeviceIDs: gpuIds, Capabilities: [['gpu', 'utility', 'compute']] }]`; since devices are fixed at container create, `start` with a different assignment recreates the container on the same volume (the workspace survives).
- [ ] **Step 1: Write failing tests** — `assignGpus picks lowest free indices`, `assignGpus 'all' needs every GPU free`, `concurrent starts never share a GPU` (fake driver with 2 GPUs, three sandboxes asking for 1, started together: two get distinct uuids, the third gets `gpu_unavailable`), `stopping frees the GPU for the next start`, `a create asking for GPUs on a place without GPUs is invalid_request`, `the Docker driver parses nvidia-smi csv` (pure parser test).
- [ ] **Step 2: Run** `pnpm test tests/gpus.spec.ts tests/sandboxes.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS. On a machine with an NVIDIA GPU and the container toolkit: create a sandbox with `gpus: 1`, run `nvidia-smi -L` through the relay — Expected: exactly one GPU listed.
- [ ] **Step 5: Commit** `feat: exclusive GPU assignment on Docker places`

### Task 8: Images on GHCR (multi-arch) and CI for agentry-sandbox

**Files:**
- Modify: `images/envd/Dockerfile` (`ARG TARGETARCH`, `GOARCH=$TARGETARCH`), `scripts/images-build.sh` (new names), `README.md`, `CHANGELOG.md`
- Create: `.github/workflows/ci.yml`, `.github/workflows/images.yml`
- Test: `tests/images.spec.ts` (names/tags match `src/config.ts` defaults)

- [ ] **Step 1: Write failing test** — `config defaults name the ghcr.io/fakhrulfaiz images` and `images-build.sh builds every default image name` (reads the script, expects the four names from Global Constraints).
- [ ] **Step 2: Run** `pnpm test tests/images.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**: envd Dockerfile honours `TARGETARCH`; `images-build.sh` builds the four images under their new names for the local architecture; `ci.yml` (push to `develop`, PRs to `main`): `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` (Docker integration suites run on the runner's Docker); `images.yml` (push to `main` and `workflow_dispatch`): `docker/build-push-action@v6` with `platforms: linux/amd64,linux/arm64` (QEMU) for each image under `images/`, tagged with its name from Global Constraints, `permissions: packages: write`. README: image names, `pnpm images:build`, that remote Docker places pull these images.
- [ ] **Step 4: Run** `pnpm test` and `bash scripts/images-build.sh` — Expected: PASS; four images built locally under the new names.
- [ ] **Step 5: Commit** `build: ghcr image names, multi-arch envd, CI and image publishing`

### Task 9: dsh-agents-api — list and choose places, GPUs

**Repo:** `~/code/dsh-agents-api` (branch from `develop`)

**Files:**
- Modify: `src/sandbox/agentry-sandbox-provider.ts`, `src/environment-types.ts`, `src/environment/environment-compat.ts`, `src/gateway.ts` (environment create body), `openapi/agentry.yaml`, `CHANGELOG.md`
- Test: `tests/agentry-sandbox-provider.spec.ts` (or the file that covers `availability`/`providerRows` today), `tests/gateway.spec.ts`

**Interfaces:**
- Consumes: Task 4 wire (`WireBackend.id/name/default/gpus/capabilities`, `create({ place })`, `WireSandbox.place/gpus`).
- Produces:
  - Provider row for `sandbox` gains `places: Array<{ id: string; name: string; kind: string; default: boolean; available: boolean; reason?: string; gpus?: { count: number; models: string[] }; capabilities: { reset: boolean; isolated: boolean; gpu: boolean } }>`; the row's own `available` is true when any place is; `default_image` comes from the default place.
  - `EnvironmentTemplateConfig` gains `place?: string` and `gpus?: number | 'all'`; `toServiceTemplate` passes both; the `sandbox` provider's `templateFields` gains `gpus`.
  - `POST /agents/environments` accepts `place` (sandbox provider only; 400 otherwise); `SandboxSummary` gains `place?: string` and `gpus?`.
- [ ] **Step 1: Write failing tests** — `providerRows lists every Agentry Sandbox place, default first`, `availability is true when any place is available`, `toServiceTemplate passes place and gpus`, `environment create forwards place to the service`, `place on a non-sandbox provider is 400`.
- [ ] **Step 2: Run** `DSH_ROOT=$HOME/code/dsh-pinned pnpm test tests/<files>` — Expected: FAIL.
- [ ] **Step 3: Implement**; the sibling `../agentry-sandbox` checkout must be on this plan's branch for the client types.
- [ ] **Step 4: Run** `DSH_ROOT=$HOME/code/dsh-pinned pnpm typecheck && DSH_ROOT=$HOME/code/dsh-pinned pnpm test` — Expected: PASS (the known flaky `sandbox-remote.spec.ts` timing test may need a re-run).
- [ ] **Step 5: Commit** `feat: list and choose Agentry Sandbox places; GPUs in templates`

### Task 10: agentry-web — places in "Runs on", GPU field

**Repo:** `~/code/agentry-web` (branch from `develop`)

**Files:**
- Modify: `src/api/types.ts` (`SandboxProvider.places`, `SandboxTemplate.place/gpus`, `SandboxEnvironment` sandbox summary `place/gpus`), `src/ui/sandboxes/RunsOnPicker.tsx`, `src/ui/sandboxes/TemplateEditorDialog.tsx`, `src/ui/sandboxes/SandboxesPage.tsx` (new environment dialog), `src/ui/sandboxes/EnvironmentDetail.tsx`, `src/ui/sandboxes/format.ts`, `mock/agentry-mock.ts` (two places, one with 2 GPUs), `CHANGELOG.md`
- Test: `tests/component/runs-on-picker.spec.tsx` (create if absent), `tests/component/template-editor.spec.tsx` (or the existing spec covering the editor), `tests/unit/sandbox-format.spec.ts`

**Interfaces:**
- Consumes: Task 9 provider row `places`, template `place`/`gpus`, environment create `place`.
- Behaviour (astryx components, StyleX only for layout glue):
  - "Runs on": under "Isolated sandbox", one choice per place: name, plain-words kind ("Docker on this server", "Docker over SSH"), availability, and "2 GPUs" when it has any; unavailable places are disabled with their reason. The default place is preselected.
  - Template editor: a "GPUs" number field (0–count of the chosen place, plus "All") shown only when the chosen place has GPUs; the place is saved as `place`.
  - New environment dialog: place choice (same list) when the provider is `sandbox`.
  - Environment detail: "Runs on <place name>" and the GPU count; Reset hidden when the place's `capabilities.reset` is false.
- [ ] **Step 1: Write failing tests** — `lists each place with its GPU count`, `disables an unavailable place and shows why`, `GPU field appears only for a place with GPUs and caps at its count`, `template body carries place and gpus`.
- [ ] **Step 2: Run** `pnpm vitest run tests/component/runs-on-picker.spec.tsx tests/unit/sandbox-format.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm vitest run --no-file-parallelism` — Expected: PASS. Then `pnpm test:e2e` once before merging (repo rule).
- [ ] **Step 5: Commit** `feat: choose a sandbox place and GPUs`

---

## Self-review notes

- Spec coverage: places table + encrypted secrets (T1), contract + shared layer (T2), registry/routing/unavailable/disabled/limits/upgrade (T3), wire + admin API + host key flow (T4, T5, T6), remote Docker (T6), exclusive GPUs (T7, spec § GPU sharing), images/GHCR (T8), API (T9), web (T10). Deferred by the spec: SSH machine, E2B, Kubernetes, envd binaries inside the service (needed only by plan 2/3; Docker places read envd from the multi-arch image on their own host).
- Order: T1→T2→T3 are sequential; T4–T8 depend on T3; T9 on T4; T10 on T9.
