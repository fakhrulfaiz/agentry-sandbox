# Sandbox next: runbook, audit and metrics, MCP adoption, snapshots, Daytona, Modal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The five pieces of `docs/superpowers/specs/2026-11-26-sandbox-next-design.md`, in six phases that each ship on their own.

**Architecture:** Everything lands in agentry-sandbox first (records, routes, drivers), behind the existing driver contract and HTTP server; the Agentry API and web app follow with small tasks at the end of the phases that need them (adoption, keys, snapshots UI).

**Tech Stack:** Node 24, TypeScript, Postgres (migrations in `migrations/`), Vitest with fakes (fake Daytona HTTP server, fake `modal` client), live suites gated by env. No new dependency except `modal` (Phase 5, exact version).

**Spec:** `docs/superpowers/specs/2026-11-26-sandbox-next-design.md` (§ numbers below refer to it). Answers to its open questions may change a task; check the spec's "Open questions" against the operator's answers before starting a phase.

**Model per task:** **[Sonnet]** = well-specified, local change; **[Opus]** = design judgement, live spikes, security-sensitive code, or cross-repo wiring.

## Global Constraints

- Commit as `fakhrulfaiz <fakhrulfaiz2003@gmail.com>`; no `Co-Authored-By`, no AI attribution anywhere. `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`. Work in a worktree from `develop` (`git -C ~/code/<repo> worktree add ~/code/wt/<repo>-<slug> -b feat/<slug> develop`).
- Checks: agentry-sandbox `pnpm typecheck && pnpm test`; dsh-agents-api `export DSH_ROOT=/home/mffaiz/code/dsh-pinned; pnpm typecheck && pnpm vitest run`; agentry-web `pnpm typecheck && pnpm vitest run --no-file-parallelism`.
- Every route change updates `openapi/agentry-sandbox.yaml` (agentry-sandbox) or `openapi/agentry.yaml` (dsh-agents-api); the drift tests enforce it. Every behaviour change gets a dated bullet at the top of `CHANGELOG.md`.
- Secrets (provider keys, envd tokens, Daytona preview tokens, Modal connect tokens, owner keys) never appear in a response, a log line, an audit row, an error message or a metric label. Tests assert this wherever a new secret is handled.
- Owner scoping: every new record (snapshots, audit rows, labels, keys) is read and written per owner; another owner's id answers 404.
- Tests never call real providers; live suites skip unless their env var is set (`AGENTRY_SANDBOX_TEST_DAYTONA_KEY`, `AGENTRY_SANDBOX_TEST_MODAL_TOKEN`).
- agentry-web UI: astryx components and tokens only (`pnpm exec astryx component <Name>` before using one).

## Review Focus

1. **Audit never stores secrets:** a command with `--password=x`, an `ask_…` key or an env value in `Start` is masked (Phase 1 Task 3 test `masks secrets in command lines`).
2. **Audit never breaks a request:** a failing audit insert still answers the request (Phase 1 Task 2 test `a store error is logged, not thrown`).
3. **Metrics carry no ids or owners by default** (Phase 1 Task 5 test `route labels use templates, not raw paths`).
4. **Adoption never duplicates an environment** made before labels existed (Phase 2 Task 5 test `existing environments are back-filled, not adopted`) and never adopts twice under a race (`a 409 claim is skipped`).
5. **Snapshots are owner-scoped** across snapshot and sandbox ids (Phase 3 Task 3 test `restore with another owner's snapshot is 404`).
6. **No open envd on hosted places:** Daytona and Modal endpoints always carry the preview/connect token; a request without it is refused by the fake (Phase 4 Task 3, Phase 5 Task 3).

---

## Phase 0 — SSH-machine runbook (§ 5)

### Task 0.1: Write the runbook [Sonnet]

**Files:**
- Create: `docs/runbooks/ssh-machine-check.md` (copy § 5 of the spec verbatim, then add an empty results table: distro, `uname -m`, sudo version, iptables backend, steps 3–10 pass/fail, notes)
- Modify: `README.md` ("Real-machine check" bullet links the runbook instead of listing the five items), `docs/overview.md` (no change unless it mentions the check), `CHANGELOG.md`

- [ ] **Step 1:** Write the file; check every command in it against `src/places/drivers/ssh-machine.ts` (`ss -ltn`, `pgrep -s`, `pkill -<sig> -s`, `nohup sudo -n setsid`, iptables rule tag `agentry-<id>`); fix the runbook where the code differs.
- [ ] **Step 2:** `pnpm typecheck && pnpm test` (docs only; must stay green).
- [ ] **Step 3: Commit** `docs: SSH machine real-machine check runbook`

### Task 0.2: Run it on a real machine [operator, with Opus assisting]

Not an implementer task: needs a VM and the operator. Results go into the runbook's table and `CHANGELOG.md`; each failure becomes a fix task with the captured real output as a test fixture in `tests/ssh-machine.spec.ts`.

---

## Phase 1 — Audit log and metrics (§ 3)

### Task 1.1: Audit records in the store [Sonnet]

**Files:**
- Create: `migrations/0004_audit.sql` (table `audit_events` as in § 3, indexes `(owner, at desc)`, `(sandbox_id, at desc)`, `(at)`)
- Modify: `src/store/types.ts` (`AuditEvent`, `AuditQuery { owner?, sandboxId?, action?, since?, until?, before?: number, limit }`, `Store.audit: { insertMany(rows), list(q), deleteOlderThan(at, batch): Promise<number> }`), `src/store/memory.ts`, `src/store/postgres.ts`
- Test: `tests/store-contract.ts` (new `audit` cases run by both `store-memory.spec.ts` and `store-postgres.spec.ts`)

Note: migrations apply in file-name order; numbers follow build order (`0004` audit, `0005` labels, `0006` snapshots). If phases land in another order, take the next free number.

- [ ] **Step 1: Failing tests** — `inserts and lists newest first`, `filters by owner, sandbox, action and time`, `pages with before`, `deleteOlderThan removes at most one batch`.
- [ ] **Step 2: Run** `pnpm test tests/store-memory.spec.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — PASS (Postgres suite runs where the test database is available).
- [ ] **Step 5: Commit** `feat: audit event store`

### Task 1.2: The audit writer [Sonnet]

**Files:**
- Create: `src/audit/writer.ts` (`createAuditWriter({ store, log, flushMs = 1000, maxBatch = 100 })` → `{ record(event), flush(), close() }`; queue in memory; on store error log once per minute and drop the batch; counts for metrics `queueDepth()`, `failures()`)
- Test: `tests/audit-writer.spec.ts`

- [ ] **Step 1: Failing tests** — `flushes after the interval`, `flushes at maxBatch`, `a store error is logged, not thrown`, `close flushes what is queued`.
- [ ] **Steps 2–4:** run (FAIL) → implement → `pnpm typecheck && pnpm test` (PASS).
- [ ] **Step 5: Commit** `feat: buffered audit writer`

### Task 1.3: Command-line masking [Opus]

**Files:**
- Create: `src/audit/mask.ts` (`describeStart(req, mode: 'line' | 'name' | 'off')` → `{ command?: string; cwd?: string; pty: boolean }`; masks `--password=…`, `--token …`, `-p<x>` for mysql-like tools, `KEY=value` where KEY matches `/(pass|secret|token|key|auth)/i`, `Authorization: …`, strings starting `ask_`, `sk-`, `ghp_`, `xox`, `AKIA`; env values never kept; cut to 300 characters)
- Modify: `src/config.ts` (`AGENTRY_SANDBOX_AUDIT_COMMANDS` = `line` | `name` | `off`, default per the operator's answer to open question 4, `line` until then; `AGENTRY_SANDBOX_AUDIT_DAYS` default 90)
- Test: `tests/audit-mask.spec.ts`, `tests/config.spec.ts`

- [ ] **Step 1: Failing tests** — `masks secrets in command lines` (a table of 15+ cases), `name mode keeps only the program`, `off keeps nothing`, `pty starts are marked`, `env values never appear`.
- [ ] **Steps 2–4:** run → implement → PASS.
- [ ] **Step 5: Commit** `feat: masked command text for the audit log`

### Task 1.4: Record events everywhere [Opus]

**Files:**
- Modify: `src/http/server.ts` (an `AuditContext` per request: `actor_kind`, `actor` = owner key id or `sha256(key)` first 12 hex for a service key, `via`, `on_behalf` from `X-Agentry-Actor` (max 128 chars, printable), `request_id` = `X-Request-Id` or a new uuid echoed back; one event per sandbox/template/admin route with outcome `ok` / `denied` (quota, 4xx) / `error` (5xx)), `src/http/relay.ts` (decode envd `process.Process/Start` and filesystem writes/removes and the file upload `POST /files`; Connect JSON and binary protobuf via the generated types in `src/envd/gen`; record `envd.exec` / `envd.terminal` / `envd.write` with `describeStart`), `src/sandboxes.ts` (`system` events: `sandbox.idle_stop` from the sweep, `sandbox.forgotten` from reconcile), `src/mcp/handler.ts` (send `X-Agentry-Via: mcp` on its self-calls), `src/main.ts` (writer wiring, flush on shutdown, hourly retention prune in the sweep loop)
- Test: `tests/audit-http.spec.ts` (uses `tests/support/server.ts` and the fake driver)

- [ ] **Step 1: Failing tests** — `create, start, stop, reset, delete each write one row`, `a quota refusal is recorded as denied`, `an exec through the relay is recorded with masked text`, `a terminal start is envd.terminal`, `file writes are recorded, reads are not`, `owner keys record their key id, service keys a hash prefix`, `X-Agentry-Actor lands in on_behalf`, `MCP calls are via mcp`, `the idle sweep records system events`, `retention prune deletes old rows`.
- [ ] **Steps 2–4:** run → implement → PASS.
- [ ] **Step 5: Commit** `feat: audit events for sandbox, template, envd and admin actions`

### Task 1.5: Reading the audit log [Sonnet]

**Files:**
- Modify: `src/http/server.ts` (`GET /v1/admin/audit`, `GET /v1/audit` owner-scoped; `limit` 1–500, default 100; `before` cursor), `openapi/agentry-sandbox.yaml`, `src/client/index.ts` (`audit(query)` for the owner route), `src/admin/index.html` ("Activity" section: filters owner/sandbox/action, newest first, "Older" button), `README.md` (Audit log section: what is recorded, masking modes, retention), `CHANGELOG.md`
- Test: `tests/admin.spec.ts`, `tests/http.spec.ts`, `tests/openapi-drift.spec.ts` (already enforces)

- [ ] **Step 1: Failing tests** — `admin audit filters and pages`, `owner audit shows only the owner's rows`, `audit routes need the right key`.
- [ ] **Steps 2–4:** run → implement → PASS.
- [ ] **Step 5: Commit** `feat: audit log routes and admin Activity section`

### Task 1.6: Metrics registry and `/metrics` [Sonnet]

**Files:**
- Create: `src/metrics/registry.ts` (counter, gauge, histogram with fixed buckets `[0.05,0.1,0.25,0.5,1,2.5,5,10,30,60,120,300]`; label sets validated against a declared list; `render()` → Prometheus text 0.0.4 with escaping), `src/metrics/service-metrics.ts` (the metrics of § 3 declared once; helpers `timeOp(op, place, fn)`)
- Modify: `src/config.ts` (`AGENTRY_SANDBOX_METRICS_TOKEN`, `AGENTRY_SANDBOX_METRICS_OWNER_LABEL`), `src/http/server.ts` (`GET /metrics`: 404 when no token is set, 401 without the right bearer, constant-time compare; per-request `http_requests_total` with the matched route template), `src/sandboxes.ts` (wrap create/start/stop/reset/delete/provision in `timeOp`; quota denials; idle stops; forgotten), `src/http/relay.ts` (`relay_requests_total{service,code}`, `relay_open_streams`), `src/places/registry.ts` (`place_up`, `place_probe_seconds`), `src/main.ts` (30 s gauge refresh: `sandboxes{place,state}`, `gpus{place,state}`, `audit_queue_depth`), `openapi/agentry-sandbox.yaml`, `README.md` (Metrics section with a sample scrape config), `CHANGELOG.md`
- Test: `tests/metrics.spec.ts`

- [ ] **Step 1: Failing tests** — `renders counters, gauges and histograms in text format`, `escapes label values`, `metrics is 404 without a token and 401 with a wrong one`, `route labels use templates, not raw paths` (no `sbx_` in output after calling `/v1/sandboxes/sbx_x`), `no owner label unless switched on`, `operations are timed per place and outcome`.
- [ ] **Steps 2–4:** run → implement → PASS.
- [ ] **Step 5: Commit** `feat: Prometheus metrics endpoint`

### Task 1.7: API passes who acted [Sonnet] (dsh-agents-api)

**Files:**
- Modify (dsh-agents-api): `src/sandbox/agentry-sandbox-provider.ts` and `src/mount-sandbox-tools.ts` (send `X-Agentry-Actor: session:<id>` when a chat's tool acts, `user` for web requests) — through an optional `actor` on `createSandboxApi` in agentry-sandbox `src/client/index.ts` (add it there first, in this phase's agentry-sandbox branch), `CHANGELOG.md`
- Test: `tests/sandbox-provider.spec.ts`, `tests/sandbox-tools.spec.ts`

- [ ] **Steps 1–5:** failing test `sends X-Agentry-Actor` → implement → checks → commit `feat: tell Agentry Sandbox which session acted`

---

## Phase 2 — MCP-made sandboxes in Agentry Web (§ 4)

### Task 2.1: Sandbox labels and `created_via` [Sonnet]

**Files:**
- Create: `migrations/0005_sandbox_labels.sql` (`alter table sandboxes add column labels jsonb not null default '{}', add column created_via text`)
- Modify: `src/store/types.ts` (`SandboxRecord.labels`, `createdVia`; `SandboxPatch` gains `labels`), `src/store/memory.ts`, `src/store/postgres.ts` (add an atomic `claimLabels(id, owner, set, ifAbsent): 'ok' | 'conflict' | 'missing'` using `where not (labels ?| $absent)`), `src/sandboxes.ts` (`create` takes `labels`, `createdVia`; validation 16 keys / 64 / 256, printable), `src/http/server.ts` (`POST /v1/sandboxes { labels }`; `PATCH /v1/sandboxes/{id} { name?, labels?, if_labels_absent? }` → 409 `label_conflict`; `created_via` from the key kind and `X-Agentry-Via`), `src/client/index.ts` (`WireSandbox.labels`, `created_via`; `patch()`), `openapi/agentry-sandbox.yaml`, `CHANGELOG.md`
- Test: `tests/store-contract.ts`, `tests/sandboxes.spec.ts`, `tests/http.spec.ts`, `tests/client.spec.ts`

- [ ] **Step 1: Failing tests** — `labels round-trip on create and get`, `patch with if_labels_absent conflicts when present`, `concurrent claims: exactly one wins` (Postgres and memory), `invalid labels are 400`, `created_via is mcp for MCP self-calls, api for the service key`.
- [ ] **Steps 2–4:** run → implement → PASS.
- [ ] **Step 5: Commit** `feat: sandbox labels, atomic label claims and created_via`

### Task 2.2: Owner keys made through the API [Sonnet]

**Files:**
- Modify: `src/http/owner-keys.ts` (`listFor(owner)`), `src/http/server.ts` (`POST /v1/keys { name }`, `GET /v1/keys`, `DELETE /v1/keys/{id}` — service API key only, owner from `X-Agentry-Owner`; an owner key calling them answers 403; at most 10 keys per owner), `src/admin/index.html` (owner field: a picker of known owners — distinct owners of sandboxes, templates and keys — plus free text with the warning of § 4), `src/http/server.ts` (`GET /v1/admin/owners`), `src/client/index.ts` (`keys.create/list/revoke`), `openapi/agentry-sandbox.yaml`, `README.md` and `docs/overview.md` (MCP section: get your key from Agentry Web), `CHANGELOG.md`
- Test: `tests/owner-keys.spec.ts`, `tests/admin.spec.ts`

- [ ] **Step 1: Failing tests** — `service key makes a key for the named owner`, `an owner key cannot make keys`, `list and revoke are owner-scoped`, `admin owners lists distinct owners`.
- [ ] **Steps 2–4** → **Step 5: Commit** `feat: owner keys through the service API; admin owner picker`

### Task 2.3: MCP background processes and file list [Sonnet]

**Files:**
- Modify: `src/mcp/handler.ts` (`sandbox_exec` `background: true` → starts `sh -c '<cmd> > /tmp/agentry-mcp/<n>.log 2>&1; echo $? > /tmp/agentry-mcp/<n>.exit'` detached and returns `process_id` (envd pid) and `log`; `sandbox_process_output { id, process_id, since_bytes? }` → `{ running, exit_code?, output, next_bytes }` (64 KB max per call); `sandbox_process_kill`; `sandbox_list_files { id, path? }` one level with sizes), `docs/overview.md` (tool list; why there are no terminals), `CHANGELOG.md`
- Test: `tests/mcp.spec.ts` (create; there is no MCP spec yet — follow `tests/http.spec.ts`'s server setup and the fake driver's envd)

- [ ] **Step 1: Failing tests** — `tools/list includes the new tools`, `background exec returns a process id`, `output pages by since_bytes`, `kill ends it`, `list_files lists one level`.
- [ ] **Steps 2–4** → **Step 5: Commit** `feat: MCP background processes and file listing`

### Task 2.4: Label new environments [Sonnet] (dsh-agents-api)

**Files:**
- Modify (dsh-agents-api): `src/sandbox/agentry-sandbox-provider.ts` (`create` sends `labels: { 'agentry.environment': environmentId }`), `CHANGELOG.md`
- Test: `tests/sandbox-provider.spec.ts`

- [ ] **Steps 1–5:** failing test `create labels the sandbox with the environment id` → implement → checks → commit `feat: label sandboxes with their environment id`

### Task 2.5: Adoption [Opus] (dsh-agents-api)

**Files:**
- Create (dsh-agents-api): `src/sandbox/adoption.ts` (`adoptSandboxes({ store, provider, owner, now })`: throttle 30 s per owner in memory; list the owner's sandboxes; load the owner's sandbox environments; back-fill the label for sandboxes already referenced; claim the rest with `if_labels_absent`; write records `{ provider: 'sandbox', provider_metadata: { sandbox_id, workspace_directory, owner, image, name, adopted: 'true', origin } }`; un-claim when the write fails; remove adopted records whose sandbox answers 404; scope per open question 8), `tests/sandbox-adoption.spec.ts`
- Modify (dsh-agents-api): `src/gateway.ts` (`listEnvironments` runs adoption first, `?refresh=1` skips the throttle; failures are logged and never fail the list), `openapi/agentry.yaml` (`refresh` query; `provider_metadata.adopted`/`origin` documented), `CHANGELOG.md`, `AGENTS.md` (note), `docs/changes/2026-11-26-sandbox-adoption.md` + row in `docs/README.md`

- [ ] **Step 1: Failing tests** — `an MCP sandbox appears as an environment`, `existing environments are back-filled, not adopted`, `a 409 claim is skipped`, `a failed record write releases the claim`, `adopted environments whose sandbox is gone are removed`, `created environments whose sandbox is gone are kept`, `the pass is throttled per owner`, `a service outage leaves the list working`.
- [ ] **Steps 2–4** → **Step 5: Commit** `feat: adopt sandboxes made outside Agentry as environments`

### Task 2.6: MCP keys in the API [Sonnet] (dsh-agents-api)

**Files:**
- Modify (dsh-agents-api): `src/gateway.ts` (`POST/GET /v1/agents/sandbox-keys`, `DELETE /v1/agents/sandbox-keys/{id}`; the response to POST carries the key once and `mcp_url` from a new runtime-config value `sandbox.mcpUrl` (public URL of the service's `/mcp`)), `src/runtime-config.ts`, `openapi/agentry.yaml`, `CHANGELOG.md`
- Test: `tests/gateway.spec.ts` (or a new `tests/sandbox-keys.spec.ts`), `tests/runtime-config-sandbox.spec.ts`

- [ ] **Steps 1–5:** failing tests `creates a key for the signed-in owner`, `lists and revokes only own keys`, `404 when no sandbox service is configured` → implement → commit `feat: sandbox MCP keys for the signed-in user`

### Task 2.7: Web: MCP panel and adopted note [Sonnet] (agentry-web)

**Files:**
- Create (agentry-web): `src/ui/sandboxes/McpKeysPanel.tsx` (create key → shown once with a copy button and the `claude mcp add --transport http sandbox <mcp_url> --header "Authorization: Bearer <key>"` line; list with created date; revoke with confirm), `tests/component/mcp-keys.spec.tsx`
- Modify (agentry-web): `src/server/allowlist.ts` (`agents/sandbox-keys` GET/POST, `agents/sandbox-keys/{id}` DELETE), `src/api/client.ts`, `src/api/types.ts`, `src/ui/sandboxes/SandboxesPage.tsx` (panel), `src/ui/sandboxes/EnvironmentDetail.tsx` ("Made with an MCP client" note when `origin` is `mcp`), `tests/component/environment-detail.spec.tsx`, `CHANGELOG.md`

- [ ] **Steps 1–5:** failing component tests `shows the key once`, `revokes after confirm`, `adopted environments show the note` → implement (astryx only) → checks → commit `feat: connect an MCP client to your sandboxes`

---

## Phase 3 — Snapshots (§ 2)

### Task 3.1: Snapshot records [Sonnet]

**Files:**
- Create: `migrations/0006_snapshots.sql` (next free number if phases landed in another order), table per § 2
- Modify: `src/store/types.ts` (`SnapshotRecord`, `SnapshotLevel`, `Store.snapshots { insert, get(id, owner), list(owner, { sandboxId? }), update, delete, listExpired(at) }`), `src/store/memory.ts`, `src/store/postgres.ts`
- Test: `tests/store-contract.ts`

- [ ] **Steps 1–5:** failing contract tests (owner-scoped get, list by sandbox, expired listing) → implement → commit `feat: snapshot records`

### Task 3.2: Generic workspace snapshot through envd [Opus]

**Files:**
- Create: `src/snapshots/workspace-tar.ts` (`saveWorkspace(envd, workspace, file, maxBytes)`: runs `tar -czf - -C <ws> .` as root via envd process streaming, writes to `<file>.part`, aborts past `maxBytes`, renames; `restoreWorkspace(envd, workspace, file)`: empties the workspace (`find <ws> -mindepth 1 -delete`, keeping nothing), streams the tar in through process stdin `tar -xzf - -C <ws>`, then `chown -R agent:` (or the driver's `agentUser`)), `src/snapshots/files.ts` (store folder, safe names `snap_<hex>.tar.gz`, remove), `tests/snapshot-workspace.spec.ts` (uses `tests/support/bare-envd.ts` when Docker is present, else a fake envd process stream)
- Modify: `src/config.ts` (`AGENTRY_SANDBOX_SNAPSHOT_DIR`, `_MAX_MB` 2048, `_DAYS` 30, `AGENTRY_SANDBOX_MAX_SNAPSHOTS_PER_OWNER` 10), `tests/config.spec.ts`

- [ ] **Step 1: Failing tests** — `saves and restores a workspace byte for byte` (files, empty dirs, symlinks, modes), `aborts past the size limit and leaves no file`, `restore empties the workspace first`, `files end owned by the agent user`.
- [ ] **Steps 2–4** → **Step 5: Commit** `feat: workspace snapshots through envd`

### Task 3.3: Snapshot service and routes [Opus]

**Files:**
- Modify: `src/places/driver.ts` (optional `snapshot`, `restoreSnapshot`, `createFromSnapshot`, `deleteSnapshot`; `Capabilities.snapshots`), `src/sandboxes.ts` (`snapshot(owner, id, opts)` → record `saving`, work runs in the background under the sandbox lock, `stop_first` handled; `restore(owner, id, snapId)`; `create` with `snapshot`; `deleteSnapshot`; per-owner count limit; expired-snapshot sweep; `workspace` uses the generic path unless the driver has a native one and the restore is on the same place), `src/http/server.ts` (routes of § 2: `POST /v1/sandboxes/{id}/snapshots` 202, `GET /v1/snapshots`, `GET/DELETE /v1/snapshots/{id}`, `POST /v1/sandboxes/{id}/restore`, `POST /v1/sandboxes { snapshot }`; 400 `snapshots_off` without the folder; audit events `snapshot.create/delete`, `sandbox.restore`; metrics `op=snapshot|restore`), `src/client/index.ts`, `openapi/agentry-sandbox.yaml`, `src/admin/index.html` (snapshots per owner with size, delete), `README.md` (Snapshots section with the per-kind table), `docs/overview.md` ("no snapshots" line removed), `CHANGELOG.md`
- Test: `tests/snapshots.spec.ts` (fake driver + memory store + generic path against a fake envd)

- [ ] **Step 1: Failing tests** — `snapshot then restore in place`, `new sandbox from a workspace snapshot on another place`, `a level the place lacks is 400 naming it`, `restore with another owner's snapshot is 404`, `the per-owner limit is 429`, `deleting the sandbox keeps its snapshots`, `expired snapshots are swept`, `stop_first stops, snapshots and starts again`, `a failed snapshot is marked failed with its reason and its file removed`.
- [ ] **Steps 2–4** → **Step 5: Commit** `feat: snapshots: save, restore, new sandbox from a snapshot`

### Task 3.4: Docker native snapshots [Sonnet]

**Files:**
- Modify: `src/places/drivers/docker.ts` (`snapshot`: `workspace` = new volume `agentry-snap-<snapId>` filled by a helper container `cp -a /from/. /to/` (same hardening as the netguard helper, no network); `disk` = pause, `commit` to `agentry-snap:<snapId>` with labels `agentry.snapshot.id/owner`, unpause, plus the volume copy; `createFromSnapshot`/`restoreSnapshot` from them; `deleteSnapshot` removes volume and image; `capabilities.snapshots: ['workspace', 'disk']`), `src/places/drivers/docker-ssh.ts` (inherits), `tests/docker-driver.spec.ts` (Docker suite, skips without Docker)

- [ ] **Steps 1–5:** failing tests `volume copy restores files`, `disk snapshot keeps installed packages`, `delete removes volume and image` → implement → commit `feat: Docker-native workspace and disk snapshots`

### Task 3.5: E2B native snapshots [Sonnet]

**Files:**
- Modify: `src/places/drivers/e2b.ts` (`snapshot` with `level: 'disk' | 'memory'` → `POST /sandboxes/{id}/snapshots { memory }` with an `Idempotency-Key` = snapshot id; handle `{ e2bSnapshotId }`; `createFromSnapshot`/`restoreSnapshot` = create with `templateID: <snapshotID>` (confirm on the live suite) and swap the handle; `deleteSnapshot` = delete the E2B template (confirm path on the live suite; if none, record that E2B keeps it and say so in the README); `capabilities.snapshots: ['disk', 'memory']`), `tests/support/fake-e2b.ts` (snapshot routes), `tests/e2b.spec.ts`, `tests/e2b.live.spec.ts`
- [ ] **Steps 1–5:** failing tests `memory snapshot then new sandbox from it`, `409 while pausing is retried once`, `503 is place_unavailable` → implement → commit `feat: E2B disk and memory snapshots`

### Task 3.6: SSH machine workspace snapshots on the machine [Sonnet]

**Files:**
- Modify: `src/places/drivers/ssh-machine.ts` (`snapshot` `workspace` → `sudo -n tar -czf ~/.agentry/snapshots/<snapId>.tar.gz -C <ws> .`; restore same place only; delete removes the file; `capabilities.snapshots: ['workspace']`), `tests/support/fake-machine.ts`, `tests/ssh-machine.spec.ts`
- [ ] **Steps 1–5:** failing tests → implement → commit `feat: SSH machine workspace snapshots kept on the machine`

### Task 3.7: MCP snapshot tools [Sonnet]

**Files:** Modify `src/mcp/handler.ts` (`sandbox_snapshot { id, name?, level? }` waits up to 10 min for `ready`; `sandbox_restore { id, snapshot }`; `sandbox_list_snapshots`), `tests/mcp.spec.ts`, `docs/overview.md`, `CHANGELOG.md`
- [ ] **Steps 1–5** → commit `feat: MCP snapshot tools`

### Task 3.8: API and web snapshots [Sonnet ×2] (dsh-agents-api, agentry-web)

Two commits, one per repo, each with its tests: API routes `POST/GET /v1/agents/environments/{id}/snapshots`, `DELETE /v1/agents/environments/snapshots/{snap}`, `POST /v1/agents/environments/{id}/restore`, environment create `{ snapshot_id }` (`src/gateway.ts`, `src/sandbox/agentry-sandbox-provider.ts`, `openapi/agentry.yaml`, `docs/changes/…`); web "Snapshots" section on `src/ui/sandboxes/EnvironmentDetail.tsx` (save with level choices from the place's capabilities, list, restore with confirm, new environment from snapshot, delete), allow-list and client updates, `tests/component/environment-detail.spec.tsx`.

---

## Phase 4 — Daytona places (§ 1a, § 1c)

### Task 4.1: Spike [Opus, live, operator's Daytona key]

**Files:** Create `scripts/spikes/daytona.ts` (not imported by the service; deleted or kept under `scripts/spikes/` with a header saying it is a spike).
- [ ] Answer the four spike questions of § 1a with a real sandbox: toolbox user and sudo; envd upload, start and `/init`; a `process.Process/Start` stream of `for i in $(seq 60); do echo $i; sleep 1; done` arrives line by line through the preview URL; headers reach envd; an idle stream of 10 min survives; the token changes after stop/start.
- [ ] Write the findings into the spec under § 1a "Spike results (date)", and fix the driver design if needed. If streaming fails, stop and ask the operator (open question 1).
- [ ] **Commit** `docs: Daytona spike results`

### Task 4.2: Provider GPUs (`gpuSource`) [Sonnet]

**Files:** Modify `src/places/driver.ts` (`Capabilities.gpuSource?`), `src/sandboxes.ts` (skip seats for `'provider'`; refuse `"all"`; cap by place `max_gpus`), `src/places/registry.ts` (`max_gpus` from config), `src/http/server.ts` (`GET /v1/backends` reports `gpus: { count: max_gpus, models: [gpu_type] }` for provider places), `openapi/agentry-sandbox.yaml`, `tests/gpus.spec.ts`, `tests/sandboxes.spec.ts`
- [ ] **Steps 1–5:** failing tests `provider GPUs pass the count through`, `all is refused on provider places`, `count above max_gpus is 400` → commit `feat: GPUs allocated by the provider`

### Task 4.3: Fake Daytona and the driver [Opus]

**Files:**
- Create: `tests/support/fake-daytona.ts` (REST: create/get/start/stop/delete/labels list; toolbox: file upload, process start; preview proxy that forwards to a local bare envd process **only** with the right `x-daytona-preview-token`, and rotates the token on stop/start; knobs for 429/5xx), `src/places/drivers/daytona.ts`, `tests/daytona.spec.ts`, `tests/daytona.live.spec.ts`
- Modify: `src/places/registry.ts` / `src/main.ts` (`daytona: daytonaFactory()`), `src/http/server.ts` (admin test for kind `daytona`), `src/admin/index.html` (kind "Daytona (hosted)": API key, URL, region, base image or snapshot, "Prepare" button), `openapi/agentry-sandbox.yaml`, `README.md` (Daytona places section with limits), `docs/overview.md` (places table), `CHANGELOG.md`
- [ ] **Step 1: Failing tests** — `create starts envd and inits it`, `requests without the preview token are refused by the fake` (and the driver always sends it), `the token is refreshed on start`, `stop and start keep files`, `network false blocks all`, `resources and gpus reach the create body`, `429 is place_unavailable with Retry-After`, `the API key and tokens never appear in errors`, `listManaged finds sandboxes by label`, `a create that fails half-way deletes the Daytona sandbox`.
- [ ] **Steps 2–4** → **Step 5: Commit** `feat: Daytona places`

### Task 4.4: Web wording [Sonnet] (agentry-web)

"Runs on" plain-word label "Daytona (hosted)", capabilities note; `src/ui/sandboxes/RunsOnPicker.tsx`, `src/ui/sandboxes/format.ts`, `tests/component/sandboxes.spec.tsx`, `CHANGELOG.md`. Commit `feat: Daytona places in Runs on`.

---

## Phase 5 — Modal places (§ 1b)

### Task 5.1: Spike [Opus, live, operator's Modal token]

**Files:** Create `scripts/spikes/modal.ts`.
- [ ] Pin the `modal` npm version (exact, at least two weeks old) and confirm it loads under Node 24 ESM with `tsx`.
- [ ] Answer the five spike questions of § 1b (envd injection, connect-token cookie and streaming, snapshot timings, `snapshotDirectory` + `mountImage`, image deletion/retention).
- [ ] Record results in the spec under § 1b "Spike results (date)"; ask the operator about open question 2 with the measured stop/start times.
- [ ] **Commit** `docs: Modal spike results`

### Task 5.2: Fake Modal client and the driver [Opus]

**Files:**
- Create: `src/places/drivers/modal.ts` (depends on a narrow `ModalLike` interface — create, fromId, list by tags, terminate, snapshotFilesystem, snapshotDirectory, connect token, tunnels — implemented by an adapter `src/places/drivers/modal-sdk.ts` over the real `modal` package, so tests never load it), `tests/support/fake-modal.ts` (in-memory `ModalLike`; tunnel to a local bare envd guarded by the connect-token cookie; images as tarballs in memory; a clock for the 24 h ceiling), `tests/modal.spec.ts`, `tests/modal.live.spec.ts`
- Modify: `package.json` (`modal` exact), `pnpm-lock.yaml`, `pnpm-workspace.yaml` (`allowBuilds` only if the package has a build script), `src/main.ts`, `src/http/server.ts` (admin test for `modal`), `src/admin/index.html` (kind "Modal (hosted)": token id/secret, app, environment, GPU type, max hours), `openapi/agentry-sandbox.yaml`, `README.md` (Modal places: no pause, stop = snapshot, 24 h ceiling), `docs/overview.md`, `CHANGELOG.md`
- [ ] **Step 1: Failing tests** — `create runs envd with the connect token`, `requests without the cookie are refused by the fake`, `stop snapshots and terminates; start restores the files`, `maintain stops a sandbox near its ceiling`, `reconcile does not mark a stopped sandbox missing`, `reset keeps the workspace when the place can` (per spike), `delete removes the recorded images` (per spike), `tokens never appear in errors`.
- [ ] **Steps 2–4** → **Step 5: Commit** `feat: Modal places`

### Task 5.3: Modal native snapshots [Sonnet]

Modify `src/places/drivers/modal.ts` (`snapshot` `workspace` = `snapshotDirectory`, `disk` = `snapshotFilesystem`, `capabilities.snapshots: ['workspace', 'disk']`), `tests/modal.spec.ts`. Needs Phase 3. Commit `feat: Modal-native snapshots`.

### Task 5.4: Web wording [Sonnet] (agentry-web)

As Task 4.4 for "Modal (hosted)" (note: "stopping saves the disk; running programs end").

---

## Final review [Opus]

One whole-branch review per phase (per the operator's preference: no per-task reviews), against the spec and the Review Focus list; one fix wave; no re-review after it. Then update `AGENTS.md` (agentry-sandbox) and agentry-web's `AGENTS.md` status lines.

## Self-review notes

- Phases are independent except: Phase 1 before the others (audit events are written by later phases — if a later phase is built first, its audit calls are added when Phase 1 lands); Task 5.3 needs Phase 3; Tasks 2.5–2.7 need 2.1–2.4; Tasks 4.3/5.2 need 4.2.
- Migration numbers follow build order: `0004` audit, `0005` labels, `0006` snapshots.
- Spikes come before every driver task; their results may change the driver tasks, and the plan says so.
