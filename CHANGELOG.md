# Changelog





## 2026-11-25 — E2B places

- A new place kind, `e2b` ("E2B (hosted)"): sandboxes run on E2B's hosted sandboxes through its REST API, with envd reached at E2B's shared sandbox host (sandbox id, port and the sandbox's access token sent as headers). Creates use auto-pause, so E2B's timeout pauses a sandbox instead of killing it and the next request resumes it; the service extends the timeout of sandboxes in use. The admin page offers it (API key, template, timeout; nothing to confirm). README "E2B places" has what it needs and its limits.
- A driver can keep a per-sandbox credential in its handle under a `secret.` key; the service stores it sealed in the sandbox's `handleSecrets`, apart from the handle, and hands it back on every driver call. A place kind can explain a refused template field (E2B: "E2B uses templates; set the place's template").
- Tests: the https relay test makes its throwaway certificate with `openssl` at run time (skipped when `openssl` is missing), so no private key is committed.

## 2026-11-25 — SSH machine places

- A new place kind, `ssh-machine` ("Machine over SSH"): sandboxes run directly on a Linux machine over SSH (no Docker, no isolation, the SSH user's passwordless sudo) with a loopback-only firewall rule per sandbox; the admin page offers it next to Docker over SSH, with a warning. It cannot reset a sandbox. README "SSH machine places" lists the requirements and what is written on the machine.
- SSH machine places, after the final review: a workspace must not exist yet and is deleted only when it is a marked `sandbox-...` directory the sandbox created; envd runs in its own session and stop ends that whole session (a process that starts a new session escapes), keeping the firewall rules if envd survives; other local users are rejected from envd's loopback port; the DSH runtime is installed under a lock, skipped when current and the old one kept as `dsh.prev`; pulling an image for another architecture no longer re-tags the host's image (local Docker sandboxes were affected).

## 2026-11-25 — places

- Places: one service can run sandboxes on several places. A place is a Docker host (local, remote over SSH with a pinned host key) with its connection secrets stored encrypted; each sandbox runs on its place. Docker and bootstrap code is shared through a driver and one bootstrap routine.
- Admin page: a Places section to add, edit, test and remove places, with admin places endpoints (`/v1/admin/places`). A remote place needs a confirmed host key to be saved.
- GPUs on Docker places are assigned exclusively: a sandbox holds its GPUs until it stops, and a restart prefers the GPUs it had (a recreated container redoes only the agent user and packages, never template files or setup commands). GPUs are looked for when a place is added (and once at startup for the local one), not on every request.
- Images are now `ghcr.io/fakhrulfaiz/agentry-{envd,dsh-runtime,sandbox,netguard}`, published multi-arch (amd64, arm64) by GitHub Actions on `main`; the envd and sandbox Dockerfiles follow `TARGETARCH`. Every Docker place pulls the envd, egress-guard, DSH-runtime and sandbox images on its own daemon when it lacks them, and reads envd and the DSH runtime through that daemon (its own architecture). Upgrade note: the images were renamed from `agentry/*`; an install that built them locally keeps working (the old tag is re-tagged when the pull fails), otherwise run `pnpm images:build` or wait until `images.yml` has published the public GHCR packages. Place reachability is cached for 30 s and cut off after 5 s; the idle sweep and reconciliation skip a place that does not answer. A changed host key answers 409 `place_host_key_changed` on create, start and reset. `DELETE /v1/admin/sandboxes/{id}?force=true` forgets a sandbox whose place cannot be reached (the admin page offers it), and deleting a sandbox whose place was removed forgets the record. CI runs typecheck and tests (with Postgres) on `develop` and pull requests to `main`.

## 2026-11-25 — failed creates leave nothing behind

- A create whose setup fails (or that the backend cannot finish) now removes its record and asks the backend to clean up, instead of keeping a `failed` sandbox the caller never learned the id of. The reason still comes back to the caller; the sandbox no longer counts against the owner's limits.

## 2026-11-24 — admin page

- `/admin`: a single HTML page for operators, signed in with an admin key (`AGENTRY_SANDBOX_ADMIN_KEYS`, separate from the API keys; the key stays in the browser tab's session storage). It shows the backend, the standard image's software and the defaults; every user's sandboxes with start, stop and delete; and the limits, editable live including per-user overrides. Strict content security policy, no external resources, light and dark.
- Live limits: overrides saved from the admin page are stored in the new `settings` table (migration `0002_settings.sql`), validated (whole numbers, CPU 0.1–256, memory 128 MB–1 TB, per-user keys only), applied at once, read back at startup, and cleared by "Reset to defaults".
- `/v1/admin/overview`, `/v1/admin/sandboxes`, `/v1/admin/sandboxes/{id}[/start|stop]`, `/v1/admin/limits` (admin key only; 404 when no admin keys are set). Admin keys are refused on `/v1/*` and API keys on `/v1/admin/*`.
- `scripts/dev.sh`: the development launcher, reading its keys from the Agentry API's git-ignored `.env`.

## 2026-11-24 — default image info

- `GET /v1/backends` adds `default_image: { name, runtimes, python_packages, tools }`, read from the image's `org.agentry.runtimes`, `org.agentry.python-packages` and `org.agentry.tools` labels (only `name` for an unlabelled image). The default image `agentry/sandbox:1` carries these labels; rebuild it with `scripts/images-build.sh`.

## 2026-11-24 — small fixes

- `workspace_path` may not sit inside a directory the sandbox image needs (`/opt/agentry`, `/proc`, `/sys`, `/dev`, `/etc`, `/usr`, `/bin`, `/sbin`, `/lib*`, `/boot`, `/run`, `/var/run`, `/var/lib`): 400.
- The egress guard also blocks `0.0.0.0/8`, `192.0.0.0/24`, `198.18.0.0/15`, multicast `224.0.0.0/4`, reserved `240.0.0.0/4` and the Azure host address `168.63.129.16`.
- An invalid `X-Envd-User` on the envd relay answers 400 instead of silently using envd's default user.
- Idle sweeps never overlap: a sweep that is still running is shared with the next tick.

## Unreleased

- 2026-11-24: DSH runtime injection: `images/dsh-runtime` installs DeepSeek Harness's remote helper (`@deepseek-ai/dsh-ssh`, node-script launch) and PTC worker with Node under `/opt/agentry/dsh` (read-only, `manifest.json` with paths and SHA-256 digests); the Docker backend copies it into every sandbox like envd. `AGENTRY_SANDBOX_DSH_RUNTIME_IMAGE` (default `agentry/dsh-runtime:0.2.2-rc.1`, `none` disables). Needs a glibc image (Alpine gets the files but cannot run them).
- 2026-11-25: Project created: configuration from the environment (`src/config.ts`), with named startup errors for missing or invalid values.
- 2026-11-25: `agentry/envd:envd-v0.6.13` image (E2B envd built unmodified from the pinned commit, with its Apache-2.0 license) and `agentry/sandbox:1` default image (Debian, Node 24, pnpm, Python with the Office packages, `agent` user with passwordless sudo, `/workspace`). envd's API spec vendored in `third_party/envd` (`pnpm images:build`, `scripts/vendor-envd-spec.sh`).
- 2026-11-25: Generated envd client (`src/envd/client.ts`, Connect-RPC `process`/`filesystem` plus `/health`, `/init`, `/files`), per-sandbox access tokens derived as HMAC-SHA256 of the sandbox id (`src/envd/token.ts`, never stored), and envd extraction from its image as a tar for any container (`src/backends/envd-binary.ts`). Verified against a live envd: process streaming with exit codes, file round-trip, and calls with a wrong token refused.
- 2026-11-25: Sandbox and template store: Postgres (`migrations/0001_init.sql`, forward-only migrations under an advisory lock) and an in-memory store for tests, both owner-scoped and checked by one shared contract test.
- 2026-11-25: Docker backend: one hardened container per sandbox (`CapDrop: ALL` plus a short list, not privileged, no bind mounts, pids/cpu/memory limits, optional `runsc`), envd injected into any image and published on 127.0.0.1 only, workspace on a named volume. First start creates the `agent` user with passwordless sudo (Debian or Alpine), installs template packages (apt or apk), writes template files and runs setup commands as `agent`; later starts keep everything installed. Destroy can keep the workspace volume.
- 2026-11-25: Network guard: one bridge per owner with inter-container traffic off, and tagged firewall rules applied in the Docker host namespace (by the small `agentry/netguard:1` helper) so sandboxes reach the internet but not the host, the LAN, private ranges, metadata or each other; network-off sandboxes get no new egress. Rules are re-checked on every start. Verified on Docker Desktop.
- 2026-11-25: Sandbox lifecycle service: create from a template snapshot, one start in flight per sandbox, stop, reset (keep or wipe the workspace), destroy, touch, envd endpoint plus token (starting a stopped sandbox), idle sweep, and startup reconciliation (adopt, mark missing, report unknown). In-memory fake backend for tests.
- 2026-11-25: HTTP API (`/v1`): bearer keys checked against SHA-256 hashes, `X-Agentry-Owner` on every call, owner-scoped 404s, sandboxes (create, list, get, start, stop, reset with `keep_workspace`, delete), templates (CRUD), `/backends` with availability, and 503 `backend_unavailable` when Docker is down. The envd relay (`/v1/sandboxes/{id}/envd/*`) streams both ways, injects the sandbox token, turns `X-Envd-User` into envd's Basic user, drops caller credentials, starts stopped sandboxes and aborts upstream when the client leaves. OpenAPI in `openapi/agentry-sandbox.yaml` with a drift test. The envd client gains relay mode (`headers`, `userVia: 'header'`).
- 2026-11-25: Service entry point (`src/main.ts`: migrate, reconcile, serve, idle sweep every minute, graceful shutdown), `scripts/hash-key.ts`, an end-to-end smoke test (`scripts/smoke.ts`: create, run as agent with sudo, files, stop/start, delete through the relay; a sandbox is created in under a second), and README setup and security notes.
- 2026-11-25: Limits, all configurable: sandboxes per owner (5), running per owner (2), total (50), running total (10), creates plus resets per owner per hour (20), and the largest CPU (4) and memory (8192 MB) a template may ask for, with per-owner overrides (`AGENTRY_SANDBOX_OWNER_LIMITS`). Over a limit answers 429 `quota_exceeded` with the reason; an oversized template answers 400.
- 2026-11-25: Review fixes. A create or start that fails cleans up after itself (create removes the container and volume, start stops the container), and delete works from the id alone, so nothing is left running with envd open. Docker connection errors answer 503 on every operation, and Docker calls time out after 60 s (pulls excepted). Lifecycle operations on one sandbox run one at a time on fresh records. The idle sweep skips sandboxes with an open relay connection and re-applies network rules to running ones. The relay honours backpressure. A sandbox's own firewall rules are removed on stop and delete, stale ones are pruned at startup, owner networks are /24s from `10.213.0.0/16` and are removed with the owner's last sandbox. The egress test now proves the block against a real listener on the host (timeout), with an unguarded control that gets through.
- 2026-11-25: Per-sandbox `workspace_path` on create (a clean absolute path, default `/workspace`): the workspace volume is mounted there, it is the working directory and `agent` owns it (the Agentry API mounts each sandbox at the same path as its host placeholder). Client package exports: `@agentry/sandbox/client` (`createSandboxApi`, `SandboxApiError`, wire types, the envd client in relay mode) and `@agentry/sandbox/testing` (`startTestService`: the real server over a memory store and the fake backend).
