# Agentry Sandbox: next features — design

Status: draft for approval · 2026-11-26 · repo `agentry-sandbox` (follow-ups in `dsh-agents-api` and `agentry-web`)

Plan: `docs/superpowers/plans/2026-11-26-sandbox-next.md`.

## Intent

Five pieces of work that came up once places, E2B, owner keys and the MCP endpoint landed:

1. **Two more hosted places:** Daytona and Modal.
2. **Snapshots:** save a sandbox's files (and, where the place can, its whole disk or memory) and bring them back, into the same sandbox or a new one.
3. **Metrics and an audit log:** who created, started, ran or changed what, and numbers a Prometheus server can scrape.
4. **MCP-made sandboxes in Agentry Web:** a sandbox made through `/mcp` (Claude Code, Cursor) shows up as an environment in the web app.
5. **The SSH-machine real-machine check** (README) turned into a runbook someone can follow on a real box.

Build order (cheapest and most useful first): runbook → audit and metrics → MCP adoption → snapshots → Daytona → Modal. Audit comes early because snapshots and adoption both write audit events.

## Non-goals

- Live migration of a running sandbox between places. A snapshot of files can be restored on another place; nothing else moves.
- Memory snapshots on our own machines (Docker CRIU, SSH machines). Only hosted places that offer it (E2B) get memory snapshots.
- A general time-series store. The service exposes counters and gauges; Prometheus (or anything that reads its text format) keeps history.
- Interactive terminals over MCP (see § 4, "Terminals over MCP").
- Per-user places or keys ("bring your own Daytona key"). Places stay operator-configured.

## Anti-goals (would make this a failure even if it works)

- A provider key, an envd token, a Daytona preview token or a Modal connect token reaching the API, the browser, a log line, an audit row or a metric label.
- An audit log that stores secrets people typed into commands (see § 3, "What a command row keeps").
- A snapshot one owner can read, restore or list from another owner's sandbox.
- Adoption that shows one user another user's sandbox because the owner names happened to match by accident.
- An envd port on Daytona or Modal that answers anyone on the internet before the service has set its token.

---

## 1. Daytona and Modal places

Both follow the existing contract (`src/places/driver.ts`): a driver makes the machine and gets envd reachable; the shared bootstrap provisions. Neither ships envd, so both drivers inject it the way the SSH-machine driver does (upload the binary, start it as root, `/init` with the HMAC token), using the provider's own exec and file APIs instead of SSH.

Facts below were read from the providers' public docs on 2026-11-26. Items marked **(spike)** were not confirmed there and are checked by the first task of their phase before any driver code is written.

### 1a. Daytona (`daytona`)

**What Daytona offers (docs, 2026-11-26)**

- REST API at `https://app.daytona.io/api` (self-hosted Daytona: its own URL), header `Authorization: Bearer <api key>`. Create `POST /api/sandbox`; start/stop/archive/delete per sandbox; labels (`PUT …/labels`) and listing by label.
- A sandbox is made from a Daytona *snapshot* (a prepared image, default `daytona-small` etc.) or from a public `image` reference with an explicit tag or digest (`latest`, `lts`, `stable` are refused). Our `ghcr.io/fakhrulfaiz/agentry-sandbox:1` qualifies.
- Resources: `cpu`, `memory`, `disk`, `gpu` (+ `gpuType`, a fallback list). Defaults 1 vCPU / 1 GiB / 3 GiB; organisation maximum 4 vCPU / 8 GiB / 10 GiB unless raised; up to 8 GPUs.
- Lifecycle: stop keeps the filesystem, clears memory; archive moves a stopped container sandbox to object storage; `autoStopInterval` (minutes, default 15, `0` off), `autoArchiveInterval`, `autoDeleteInterval`, `ephemeral`.
- Network: `networkBlockAll`, `networkAllowList` (CIDRs). No "block private ranges" switch of ours applies; Daytona's network is Daytona's.
- A toolbox daemon inside every sandbox (process execute, sessions, file upload/download, PTY), reached through Daytona's proxy (`https://proxy.app.daytona.io/toolbox/{sandboxId}/…`).
- Preview URLs reach any port 1–65535: `https://{port}-{sandboxId}.{proxyDomain}`. For a private sandbox the request needs `x-daytona-preview-token`; that token is sandbox-wide, cannot be revoked, **changes when the sandbox is stopped and started**, and also opens Daytona's own ports. Signed URLs (`https://{port}-{token}.{proxyDomain}`, one port, revocable, expiry 1 s–24 h) are the alternative.
- Snapshots of a running sandbox: only for VM sandboxes, and the call is experimental (`_experimental_create_snapshot`, cold, filesystem only). Container sandboxes have no stable "snapshot this sandbox" call.

**Design**

- Config `{ api_url?: 'https://app.daytona.io/api', target?: 'us' | 'eu', base?: { snapshot: string } | { image: string }, auto_archive_minutes?: number, class?: 'container' }`, secrets `{ api_key }`. A template's `image` is accepted (Daytona pulls it); when absent the place's `base` is used, defaulting to our standard image.
- **envd reachable:** after the sandbox is `started`, the driver uploads envd (our amd64 binary, the same file the SSH-machine driver uses) through the toolbox file API to `/opt/agentry/envd`, starts it as root through the toolbox (`sudo -n` when the toolbox user is not root **(spike)**), and reaches it on port 49983 through the preview URL with the preview token as a header. The driver returns `{ baseUrl: 'https://49983-<id>.<proxy>', headers: { 'x-daytona-preview-token': <token> } }`; the token is kept under `secret.previewToken` (sealed, like E2B's) and refreshed on every `start` because it changes.
- **Before `/init`:** the preview token already gates the port, so no one without the token reaches envd's unauthenticated `/init`. The driver still calls `/init` immediately after envd answers health.
- **Lifecycle:** create with `autoStopInterval: 0` (the service's own idle sweep stops sandboxes), `public: false`, labels `agentry.sandbox.id` / `agentry.sandbox.owner`. Stop = Daytona stop; start = Daytona start (from archived it takes longer; `start` waits up to `start_timeout_s`), then restart envd (memory was cleared) and re-read the preview token. Delete = Daytona delete. `listManaged` lists by label.
- **Capabilities:** `persistent: true`, `reset: true` (delete + create), `keepFilesOnReset: false` (Daytona volumes are object-storage backed and not a good live workspace; revisit later), `isolated: true`, `network: true` (`network: false` → `networkBlockAll`), `resources: true` (cpu, memory; above the org maximum Daytona answers an error we pass on as 400), `gpu: true` with a new `gpuSource: 'provider'` (§ 1c), `envdBuiltIn: false`, `runsAsRoot: true` **(spike: root or sudo)**. Template fields: `image`, `packages`, `setupCommands`, `env`, `network`, `files`, `resources`, `gpus`.
- **Preparing the image:** an admin "Prepare" button registers the place's base image as a Daytona snapshot (`POST /snapshots`) so creates do not pull the image each time. Optional; without it creates still work, just slower.

**Spike questions (Phase 4 Task 1)**

1. Which user the toolbox runs as, and whether `sudo -n` works for it in the standard and our image.
2. Whether envd's Connect streaming (process output) passes the preview proxy unbuffered, and how long an idle stream survives.
3. Whether the preview proxy forwards `X-Access-Token` and our Basic `Authorization` header to envd untouched.
4. The exact toolbox paths for file upload and detached process start (proxy host and API version).

If (2) fails — the proxy buffers or cuts streams — Daytona is not usable through envd and the fallback is a driver that speaks Daytona's toolbox directly behind an envd-shaped adapter. That is a much larger piece of work and needs the operator's go-ahead (open question 1).

### 1b. Modal (`modal`)

**What Modal offers (docs, 2026-11-26)**

- **No public REST API.** Sandboxes are driven through the official SDKs (Python, JS/TS, Go), which speak gRPC. The JS SDK is the npm package `modal` (`import { ModalClient } from 'modal'`), with `sandboxes.create/fromId/fromName/list`, and on a sandbox `exec`, `filesystem`, `tunnels`, `terminate`, `snapshotFilesystem`, `snapshotDirectory`, `mountImage`, `setTags`, `poll`, `wait`. Auth: token id + token secret.
- Sandboxes belong to a Modal App. Lifetime: default 5 minutes, maximum **24 hours** (`timeoutMs`), plus `idleTimeoutMs`. **No stop/resume**: a sandbox runs or is gone. State is kept across sandboxes by filesystem snapshots (`snapshotFilesystem` → an Image to start a new sandbox from; retention default 30 days) or directory snapshots (`snapshotDirectory` + `mountImage`).
- Resources: `cpu`/`cpuLimit`, `memoryMiB`/`memoryLimitMiB`, `gpu` as a string (`"T4"`, `"A100-80GB:4"`); GPUs need the gVisor runtime (Modal's default for sandboxes).
- Network: `blockNetwork`, `outboundCidrAllowlist`, `outboundDomainAllowlist` (beta), `inboundCidrAllowlist`. Ports: `encryptedPorts` (TLS tunnel, `tunnels()` gives the URL), `unencryptedPorts` (no inbound allowlist). **Connect tokens:** `createConnectToken({ port })` gives a URL and a token accepted as `Authorization`, a `_modal_connect_token` query parameter or cookie.
- Tags: up to 10 key/value tags, 512 bytes total; `list` filters by tags.

**Design**

- New exact dependency `modal@<version pinned at Phase 5 Task 1>`. Config `{ app: string (default 'agentry-sandbox'), environment?: string, base_image?: string, gpu_type?: string, max_hours?: number (default 23) }`, secrets `{ token_id, token_secret }`.
- **envd reachable:** the sandbox image is the template's image (`images.fromRegistry`) with envd layered in **(spike: whether Modal image builds accept a `COPY --from=<our envd image>`; fallback: write envd through `filesystem` and start it with `exec`)**. envd is the sandbox's main command, run as root, listening on 49983, published with `encryptedPorts: [49983]`. The driver creates a connect token for that port and sends it as the `_modal_connect_token` **cookie** (envd itself reads `Authorization` for the user, so the header is taken). Without a valid connect token nothing reaches envd, so the `/init` window is closed. Optional `inbound_cidrs` (the service's egress IP) narrows it further.
- **Stop/start without stop/resume:** stop = `snapshotFilesystem()` (whole disk, not memory) → remember the image id in the handle → `terminate()`. Start = create a new Modal sandbox from that image, restart envd, `/init`. Persistent in the sense the web app uses (files and installed software survive), at the cost of a slower stop and start and of losing running processes — the same as every other place except E2B.
- **24-hour ceiling:** sandboxes are created with `timeoutMs = max_hours` and `idleTimeoutMs` off (the service's idle sweep stops them). `maintain` stops (snapshots and terminates) a sandbox that is within 30 minutes of its ceiling, so Modal never kills one with unsaved files; it is started again on the next request.
- **Reset:** terminate and create from the template image. Keep files: `snapshotDirectory(workspace)` first and `mountImage(workspace, …)` into the new sandbox **(spike)**; if it works, `keepFilesOnReset: true`, else `false`.
- **Capabilities:** `persistent: true` (via snapshots), `reset: true`, `keepFilesOnReset` per spike, `isolated: true` (gVisor), `network: true` (`blockNetwork`), `resources: true`, `gpu: true` with `gpuSource: 'provider'` (`gpu_type:<count>`), `envdBuiltIn: false`, `runsAsRoot: true`. Template fields as Daytona.
- `listManaged` lists the place's app by tags `agentry.sandbox.id`, `agentry.sandbox.owner`; a stopped sandbox has no Modal sandbox, so listing only finds running ones — reconciliation must treat "stopped with a snapshot image" as fine and never mark it missing (the handle carries `stoppedImage`).
- Snapshot images left behind by deleted sandboxes: delete removes the recorded image ids (`images.delete` **(spike: exists in the JS SDK?)**; otherwise rely on Modal's TTL and say so).

**Spike questions (Phase 5 Task 1)**

1. The `modal` npm version and that it runs on Node 24 with our ESM setup.
2. envd injection (Dockerfile `COPY --from`, or file write + exec).
3. Connect-token cookie reaches envd; streaming and long idle streams work through the tunnel.
4. `snapshotFilesystem` time for a 1 GB workspace; `snapshotDirectory` + `mountImage` for reset.
5. Image deletion and snapshot retention.

### 1c. GPUs on hosted places

Today a GPU request needs GPUs the place *discovered* (`gpusOf(place)`) and hands them out as seats. Daytona and Modal allocate GPUs themselves. Add `Capabilities.gpuSource?: 'seats' | 'provider'` (absent = `'seats'`). For `'provider'` the service skips seat assignment and passes the count to the driver; `"all"` is refused on such places (400) and the place's configured maximum (`max_gpus`, admin setting) caps the count. Templates and the web app are unchanged.

---

## 2. Snapshots

A **snapshot** is a saved copy of a sandbox at one moment, owned by the sandbox's owner, that can be restored into that sandbox or used to create a new one.

### Levels

| Level | What it keeps | Restore brings back |
|---|---|---|
| `workspace` | the workspace folder's files | the files; installed software comes from the template |
| `disk` | the whole filesystem (workspace + installed software, home, `/etc`) | everything on disk; running programs are not running |
| `memory` | disk plus memory | the sandbox as it was, programs still running |

### What each kind can do

| Kind | `workspace` | `disk` | `memory` | Where it is kept | Restore on another place |
|---|---|---|---|---|---|
| Docker (local, over SSH) | yes: copy of the workspace volume (helper container, `cp -a`) | yes: `docker commit` of the container + the volume copy | no | on the place's Docker host (volume `agentry-snap-<id>`, image `agentry-snap:<id>`) | `workspace` only, via export (below) |
| Machine over SSH | yes: `tar` of the workspace to `~/.agentry/snapshots/<id>.tar.gz` on the machine | no (it is the operator's machine) | no | on the machine | `workspace` only, via export |
| E2B | yes (generic, below) | yes: E2B snapshot with `memory: false` | yes: E2B snapshot with `memory: true` | at E2B (a snapshot is an E2B template; it outlives the sandbox) | `workspace` only |
| Daytona | yes (generic) | no for container sandboxes (no stable API) | no | service store | `workspace` only |
| Modal | yes: `snapshotDirectory(workspace)` | yes: `snapshotFilesystem()` | no | at Modal (an image; TTL 30 days by default) | `workspace` only |

**Generic workspace snapshot (every kind, the first one built):** through envd, as `root`, the service runs `tar -czf - -C <workspace> .` and streams stdout into its own snapshot store (`AGENTRY_SANDBOX_SNAPSHOT_DIR`, one file per snapshot, written to a temp name and renamed when complete; the service has no data folder today, so when the variable is unset generic snapshots are off and a request answers 400 `snapshots_off` naming the variable). Restore streams it back with `tar -xzf - -C <workspace>` after emptying the workspace. Because this goes through envd and the service, it works on every place, and a `workspace` snapshot taken anywhere restores anywhere. Place-native workspace copies (Docker volume clone, SSH `tar` on the machine) are a later optimisation that avoids moving bytes through the service; they are only used for restores on the same place.

### Consistency

A snapshot of a running sandbox is taken live, like copying files while programs write to them. The request takes `stop_first: true` to stop the sandbox, snapshot, and start it again (Docker `disk` always pauses the container for the commit). E2B pauses the sandbox itself while snapshotting.

### Records and API

- New table `snapshots` (migration `0006_snapshots.sql`): `id` (`snap_…`), `owner`, `sandbox_id` (source; kept after the sandbox is deleted), `place` (where it lives; `service` for the generic store), `level`, `name`, `state` (`saving` | `ready` | `failed`), `handle` jsonb (volume/image/E2B snapshot id/file name), `handle_secrets`, `size_bytes`, `error`, `created_at`, `expires_at`.
- `POST /v1/sandboxes/{id}/snapshots` `{ name?, level?: 'workspace' (default) | 'disk' | 'memory', stop_first?: false }` → 202 with the snapshot in `saving`; it becomes `ready` or `failed`. A level the place cannot do answers 400 naming it.
- `GET /v1/snapshots[?sandbox=]`, `GET /v1/snapshots/{id}`, `DELETE /v1/snapshots/{id}` (removes the bytes, the volume, the image or the provider snapshot).
- `POST /v1/sandboxes/{id}/restore` `{ snapshot }`: `workspace` replaces the workspace files in place (sandbox running or stopped); `disk`/`memory` rebuild the sandbox from the snapshot on its own place, like a reset. Owner-checked on both ids.
- `POST /v1/sandboxes` accepts `snapshot`: a new sandbox from a template plus the snapshot's files (`workspace`), or from the snapshot itself (`disk`/`memory`, same place only).
- Driver contract (all optional): `snapshot?(id, handle, spec, opts: { level, name }) → { handle, sizeBytes? }`, `restoreSnapshot?(id, handle, spec, snap) → Handle`, `createFromSnapshot?(id, owner, spec, ctx, snap) → Handle`, `deleteSnapshot?(snap) → void`; `Capabilities.snapshots: ('workspace' | 'disk' | 'memory')[]` (the generic `workspace` is added by the service for every place, so a driver lists only its native levels).
- Limits: `AGENTRY_SANDBOX_MAX_SNAPSHOTS_PER_OWNER` (default 10), `AGENTRY_SANDBOX_SNAPSHOT_MAX_MB` (default 2048, the generic store aborts and fails the snapshot beyond it), `AGENTRY_SANDBOX_SNAPSHOT_DAYS` (default 30; the sweep deletes expired snapshots). Snapshots have their own count limit and do not count against `MAX_CREATES_PER_HOUR`.
- Deleting a sandbox keeps its snapshots (that is the point of "restore into a new sandbox"); the admin page lists them with sizes.
- MCP: `sandbox_snapshot`, `sandbox_restore` tools (Phase 3, last task).

### API and web follow-ups (separate small plans in those repos)

- **dsh-agents-api:** environment snapshot routes that call the service with the environment's sandbox (`POST /agents/environments/{id}/snapshots`, list, delete, restore; "new environment from snapshot"); an `openapi/agentry.yaml` update.
- **agentry-web:** on the environment page a "Snapshots" section: Save snapshot (name, level from the place's capabilities), list with size and date, Restore (confirm: "replaces the files in this sandbox"), New environment from snapshot, Delete.

---

## 3. Metrics and an audit log

### Audit log

Every action that creates, changes, runs or removes something is one row.

- Table `audit_events` (migration `0004_audit.sql`): `id` bigserial, `at` timestamptz, `actor_kind` (`service_key` | `owner_key` | `admin` | `system`), `actor` (key id for owner keys, `sha256` prefix of the matched service key, `admin`, or `idle-sweep`/`reconcile`), `via` (`api` | `mcp` | `admin` | `system`), `on_behalf` (text, optional: what the Agentry API passed in a new `X-Agentry-Actor` header, such as `session:sess_…` or `user`), `owner`, `action`, `sandbox_id`, `place`, `outcome` (`ok` | `denied` | `error`), `detail` jsonb (small, no secrets), `request_id`.
- **Actions:** `sandbox.create`, `.start`, `.stop`, `.reset`, `.delete`, `.restore`, `.idle_stop`, `.forgotten` (reconcile); `snapshot.create`, `.delete`; `template.create`, `.update`, `.delete`; `envd.exec` (process `Start` through the relay, including the MCP `sandbox_exec`), `envd.terminal` (process `Start` with a PTY), `envd.write` (filesystem writes, removes, the file upload endpoint); `quota.denied`; admin: `place.create/update/delete`, `limits.update/reset`, `key.create/revoke`, `admin.sandbox.start/stop/delete`.
- Reads (file reads, lists, `GET`s) are not audited: they are frequent and change nothing. Process input and terminal keystrokes are not audited.
- **What a command row keeps:** envd `Start` requests are decoded in the relay (Connect JSON or the binary protobuf the generated client already knows). By default (`AGENTRY_SANDBOX_AUDIT_COMMANDS=line`) the row keeps the command line cut to 300 characters with likely secrets masked (`--password=…`, `-p…`, `token=…`, `Authorization: …`, anything matching `ask_`/`sk-`/`ghp_` prefixes, and env values in the request). `name` keeps only the program name; `off` keeps neither. Masking is best effort, which is why the default is open question 4.
- Written asynchronously (a small in-memory queue flushed every second or 100 rows); a database error is logged and never fails the request. On shutdown the queue is flushed.
- **Reading it:** `GET /v1/admin/audit?owner=&sandbox=&action=&since=&until=&before=<id>&limit=` (admin key; newest first, cursor by id) and an "Activity" section on the admin page (filters, newest first). Owners see their own through `GET /v1/audit` (same filters, owner-scoped), which the Agentry API can surface later.
- **Retention:** `AGENTRY_SANDBOX_AUDIT_DAYS` (default 90; `0` keeps forever). The sweep deletes older rows once an hour in batches of 10 000.

### Metrics

`GET /metrics` in Prometheus text format (version 0.0.4), written by a small built-in registry (counters, gauges, histograms; no new dependency).

- **Access:** off unless `AGENTRY_SANDBOX_METRICS_TOKEN` is set (a bearer token, compared in constant time) — the service listens on 127.0.0.1 by default but may be bound wider, and metrics reveal activity.
- **Metrics** (prefix `agentry_sandbox_`):
  - `sandboxes{place,state}` gauge (from the store, refreshed every 30 s)
  - `operations_total{op,place,outcome}` counter, `operation_seconds{op,place}` histogram — `op` ∈ create, start, stop, reset, delete, provision, snapshot, restore
  - `quota_denied_total{limit}` counter
  - `place_up{place,kind}` gauge (last probe), `place_probe_seconds{place}` histogram
  - `gpus{place,state}` gauge (`free`, `held`) for seat places
  - `relay_requests_total{service,code}` (`service` = envd service name such as `process.Process`), `relay_open_streams` gauge
  - `http_requests_total{route,method,code}` with the route template (never the raw path, so no ids), `http_request_seconds{route}` histogram
  - `idle_stops_total`, `reconcile_forgotten_total{place}`
  - `snapshot_bytes{place}` gauge, `audit_queue_depth` gauge, `audit_write_failures_total`
  - process metrics: `process_resident_memory_bytes`, `process_start_time_seconds`, `nodejs_eventloop_lag_seconds`
- **No owner label by default** (it is personal data and unbounded). `AGENTRY_SANDBOX_METRICS_OWNER_LABEL=on` adds `owner` to `sandboxes` and `operations_total` for small installs.

---

## 4. MCP-made sandboxes in Agentry Web

### The problem

Agentry Web lists the API's *environments*. An environment is a row in the API's database that points at a sandbox (`provider_metadata.sandbox_id`, `owner`, `workspace_directory`). A sandbox made through the service's `/mcp` endpoint has no such row, so the web app never shows it, although the API could reach it with its service key.

### Owner matching

The API names owners by their Keycloak `sub` (an opaque id), or the dev key's configured owner in `apikey` mode. Owner-bound keys are made on the service's admin page by typing an owner name, and the README says "use the same user name as in Agentry" — but the user does not know their `sub`, and typing a display name makes a separate owner that will never match. Two changes:

1. **Users get their MCP key from Agentry Web**, not from the sandbox admin page. A new service route `POST /v1/keys` (service API key only, with `X-Agentry-Owner`) makes an owner-bound key for that owner (and `GET /v1/keys`, `DELETE /v1/keys/{id}` list and revoke that owner's keys). The API exposes it as `POST/GET/DELETE /v1/agents/sandbox-keys`; the web app shows a "Connect an MCP client" panel on the Environments page: create a key (shown once, with the ready-to-paste `claude mcp add …` line using the service's public MCP URL from config), list, revoke. The owner is always the signed-in user's, so it matches by construction.
2. The admin page keeps its Access keys section for operators, but the owner field becomes a picker of owners the service has seen (distinct owners of sandboxes, templates and keys), with free text allowed and a warning that a new name is a new, separate user.

### Adoption

- **Service side:** sandboxes get `labels` (string map, at most 16 keys, 64-char keys, 256-char values): set at create (`POST /v1/sandboxes { labels }`), returned on `WireSandbox`, changed with `PATCH /v1/sandboxes/{id}` `{ name?, labels? }`. `PATCH` takes `if_labels_absent: string[]` and answers 409 `label_conflict` when any is present, so two API processes cannot both adopt one sandbox. Each sandbox also records `created_via` (`api` | `mcp` | `owner_key` | `admin`), set by the server: `api` for a service key, `mcp` when an owner key's request carries `X-Agentry-Via: mcp` (the MCP handler's self-calls send it), else `owner_key`; `admin` for the admin page. It is informational only (the caller is already authenticated as that owner), so trusting the header from an owner key is harmless.
- **API side, new environments:** the provider sets label `agentry.environment=<env id>` when it creates a sandbox.
- **API side, adoption:** when the API lists an owner's environments (`GET /v1/agents/environments`) it asks the service for that owner's sandboxes, throttled to once per 30 s per owner (and on demand with `?refresh=1`). Every sandbox without an `agentry.environment` label is adopted: the API claims it with `PATCH … { labels: { 'agentry.environment': env_id }, if_labels_absent: ['agentry.environment'] }` and, only if that succeeds, writes an environment record `{ provider: 'sandbox', provider_metadata: { sandbox_id, workspace_directory: s.workspace_path, owner, image, name: s.name, adopted: 'true', origin: s.created_via } }`. A claim that answers 409 is skipped (another process got it). A record that cannot be written un-claims the label. **Existing environments first:** environments made before labels existed have unlabelled sandboxes. Before claiming, the pass loads the owner's environment records and, for any sandbox already referenced by `provider_metadata.sandbox_id`, only back-fills the label (no new record). Without this every old environment would be adopted a second time.
- **Owner check:** adoption lists with `X-Agentry-Owner = <owner>`, so the service only ever returns that owner's sandboxes; nothing else is compared.
- **Adopted environments behave like any other:** start, stop, reset, files, terminals, delete (which deletes the sandbox) — all already go through `provider_metadata`. There is no host placeholder; `destroy` already handles its absence.
- **Attaching a chat** to an adopted sandbox needs its workspace path to exist on the API host (DSH checks it; AGENTS.md backlog item 10). MCP-made sandboxes mount at `/workspace`, which works where the host has `/workspace`; otherwise attaching answers the existing 400 `sandbox_workspace_missing` and the environment page says why. No change here until item 10 is solved.
- **Gone sandboxes:** when a sandbox is deleted through MCP, its environment's `describe` already shows `gone`. Adopted environments whose sandbox is gone (404) are removed by the next adoption pass; created-by-Agentry ones are left for the user to delete, as today.
- **Web:** adopted environments show a small "Made with an MCP client" note (from `origin`) and nothing else differs.

### Terminals over MCP

Not offered, on purpose. MCP tools are request/response; a terminal needs a two-way stream with resize and key input, which no MCP client renders. An MCP client (Claude Code, Cursor) already has its own terminal and drives the sandbox through `sandbox_exec`. What is missing for real work is **long-running programs**, so instead add:

- `sandbox_exec` gains `background: true` → returns a `process_id` (envd pid) immediately, output kept in a file under `/tmp/agentry-mcp/<pid>.log`;
- `sandbox_process_output { id, process_id, since_bytes? }` → status (running/exit code) and new output;
- `sandbox_process_kill { id, process_id }`;
- `sandbox_list_files { id, path? }` (one level, with sizes).

People who want an interactive terminal on an MCP-made sandbox open it in Agentry Web once it is adopted.

---

## 5. SSH-machine real-machine check (runbook)

The tests use a fake machine (`tests/support/fake-machine.ts`). Five things depend on the real OS and were never checked on one: sudo relaying signals, `use_pty`/`requiretty` in sudoers, `pkill`/`pgrep` availability, the output format of `ss -ltn`, and iptables-nft behaviour. The runbook goes to `docs/runbooks/ssh-machine-check.md` and is run once per distribution family we claim (Debian/Ubuntu, RHEL/Fedora; optionally Alpine-on-glibc is not claimed). Each step says what to do, what to expect and what a failure means.

**Prepare**

1. A throwaway VM (not a machine with data), Linux x86_64 or aarch64, glibc, an SSH user `agentry-check` with key login and passwordless sudo, `iptables` (and `ip6tables` if IPv6 is on). Record `cat /etc/os-release`, `uname -m`, `sudo --version | head -1`, `iptables --version` (look for `nf_tables` or `legacy`).
2. Add the machine on the admin page as "Machine over SSH"; confirm the host key. **Expect:** the place shows available with the machine's version line. If it says "sudo needs a terminal", `requiretty` is set (see step 4).

**Checks**

3. **sudo relays signals.** Create a sandbox; run `sleep 1000 &` and `bash -c 'trap "" TERM; sleep 1000' &` through `sandbox_exec`. On the machine: `ps -o pid,sid,user,cmd -s <envd pid>` lists them in envd's session. Stop the sandbox. **Expect:** within the stop timeout `pgrep -s <envd pid>` finds nothing (the TERM-ignoring one ends on KILL), the stop succeeds, and `sudo iptables -S | grep agentry-<id>` is empty. **Failure:** processes survive → sudo is not passing signals to the session (look for `Defaults use_pty` or a sudo older than 1.9) — note it; the driver's KILL fallback must still clear them; if not, stop must fail and leave the rules (check that it does).
4. **`use_pty` and `requiretty`.** `sudo -l -U agentry-check` and `grep -r 'use_pty\|requiretty' /etc/sudoers /etc/sudoers.d`. With `Defaults use_pty` on (Debian 12+ and Ubuntu 22.04+ set it): repeat step 3 and check envd still starts detached (`nohup sudo -n setsid …` returns, `envd.log` grows, the SSH session can close). Then add `Defaults:agentry-check requiretty`, re-test the place. **Expect:** the probe reports the `requiretty` reason by name; remove the line afterwards.
5. **`pkill`/`pgrep` present.** `command -v pkill pgrep` (package `procps` / `procps-ng`). On a minimal image remove them (`sudo mv`) and create a sandbox. **Expect:** the probe or the first stop reports "pkill/pgrep missing" by name (if it does not, that is a bug to file: it must not report success).
6. **`ss -ltn` output.** Run `ss -ltn` and keep the output. Start three sandboxes so three envd ports are taken; the fourth must pick a free one. **Expect:** no "address in use" in `envd.log`. Compare the column layout with the parser's test fixtures (`tests/ssh-machine.spec.ts`); add the real output as a fixture if it differs (IPv6 `[::]:port`, `*:port`).
7. **iptables-nft.** With the nft backend (`iptables --version` says `nf_tables`): create a sandbox; `sudo iptables -S` and `sudo nft list ruleset | grep agentry` both show its rules. From another local user: `curl -m 2 http://127.0.0.1:<envd port>/health` **expect** refused/timeout; from the SSH user it answers. From another machine on the LAN: **expect** no answer. Delete the sandbox: **expect** both listings clean. Repeat with `ip6tables` when IPv6 is on (`curl -6 http://[::1]:<port>/health` from another user is refused). Also run `sudo systemctl restart nftables` (or `firewalld`) while a sandbox runs: **expect** the rules may vanish; the next start or `maintain` must put them back — if nothing does, file it.
8. **Reboot.** Reboot the machine with one sandbox running. **Expect:** status becomes stopped/missing without errors; start relaunches envd and re-adds rules; files are still there.
9. **GPU (if present).** Template `gpus: 1`; `echo $CUDA_VISIBLE_DEVICES` shows the assigned uuid; a second sandbox asking for all GPUs answers 409 `gpu_unavailable`.
10. **Clean up.** Delete every sandbox; `ls ~/.agentry/sandboxes` empty; `/workspace`-style `sandbox-*` workspaces gone; `sudo iptables -S | grep agentry` empty; remove the place.

**Record** the results table (distro, sudo version, iptables backend, each step pass/fail, notes) at the bottom of the runbook and in the CHANGELOG; turn every failure into an issue or a fix task with a test using the captured real output.

---

## Constraints

- AGENTS.md rules hold for every new kind: envd never published openly (Daytona: preview token; Modal: connect token), tokens and provider keys sealed and never returned, owner-scoped records (snapshots and audit rows too), exact dependency versions (`modal` pinned exactly), CHANGELOG per behaviour change, OpenAPI updated with every route (the drift test enforces it).
- Tests: fakes for every provider (`tests/support/fake-daytona.ts`, a fake `modal` client module), live suites gated by `AGENTRY_SANDBOX_TEST_DAYTONA_KEY` / `AGENTRY_SANDBOX_TEST_MODAL_TOKEN`, as for E2B.
- Existing installs keep working with no configuration change: metrics off, audit on with defaults, snapshots on with defaults, no new required variable.

## Open questions for the operator

1. **Daytona fallback:** if the preview proxy cannot carry envd's streams, do we build a toolbox-backed adapter (large) or drop Daytona for now?
2. **Modal stop = snapshot + terminate:** acceptable that a stop takes as long as the snapshot (tens of seconds for big disks) and that running programs end? Alternative: Modal places are "not persistent" (stop deletes, like ephemeral).
3. **Snapshot storage for the generic store:** a folder on the service host is the simplest; do you want S3-compatible object storage from the start (needed if the service runs as more than one replica or in a container without a volume)?
4. **Audit command text:** default `line` (masked, 300 chars), `name` (program name only) or `off`?
5. **Audit retention:** 90 days default OK? Should owners see their own audit log in Agentry Web, or is it admin-only?
6. **Metrics access:** bearer token only, or also allow unauthenticated scraping when bound to loopback?
7. **MCP keys from Agentry Web:** OK to give every signed-in user the power to make their own sandbox MCP keys, or should it stay admin-only (then the admin picker is the only fix)?
8. **Adoption scope:** adopt every un-labelled sandbox of the owner (including ones made by a raw `/v1` owner key), or only `created_via: mcp`?
9. **Which distributions** must the SSH-machine runbook pass on before we call that kind supported?

## Sources (read 2026-11-26)

- Daytona: [Sandboxes](https://www.daytona.io/docs/en/sandboxes.md), [Preview URLs](https://www.daytona.io/docs/en/preview.md), [Snapshots](https://www.daytona.io/docs/en/snapshots.md), [VM sandboxes](https://www.daytona.io/docs/en/sandboxes/vm-sandboxes).
- Modal: [Sandboxes guide](https://modal.com/docs/guide/sandboxes.md), [Sandbox networking](https://modal.com/docs/guide/sandbox-networking.md), [JS SDK `Sandbox`](https://modal.com/docs/sdk/js/latest/Sandbox).
- E2B: [Create snapshot API](https://docs.e2b.dev/api-reference/sandboxes/create-snapshot.md), [Snapshots](https://docs.e2b.dev/sandbox/snapshots.md), [Fork](https://docs.e2b.dev/sandbox/fork.md).
