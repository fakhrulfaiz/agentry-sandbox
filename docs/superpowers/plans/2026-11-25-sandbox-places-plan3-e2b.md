# Sandbox places, plan 3: E2B

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A place kind `e2b`: Agentry sandboxes on E2B's hosted sandboxes, created, paused, resumed and killed through E2B's REST API, with envd reached through E2B's sandbox host.

**Architecture:** E2B sandboxes already run envd (`envdBuiltIn`), so the driver only handles lifecycle and the endpoint. The envd endpoint contract grows optional HTTPS and per-request headers, used by the relay and the shared bootstrap's envd client. Stopping pauses (files and memory kept), starting connects (resumes); creates use auto-pause so E2B's timeout never kills a sandbox.

**Tech Stack:** Node 24 `fetch`, TypeScript, vitest (a local fake E2B server for tests); agentry-web wording.

**Spec:** `docs/superpowers/specs/2026-11-25-sandbox-backends-design.md` § Kind: E2B (facts below override it where they differ: the envd host form and auto-pause were confirmed 2026-11-25 from docs.e2b.dev).

## Global Constraints

- Commits as `fakhrulfaiz <fakhrulfaiz2003@gmail.com>`; no AI attribution. `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`. No live E2B calls in tests (fake server only); a live suite runs only when `AGENTRY_SANDBOX_TEST_E2B_KEY` is set and is skipped otherwise.
- Kind `e2b`. Config `{ template: string (E2B template id or name, default 'base'), api_url?: string (default 'https://api.e2b.app'), sandbox_host?: string (default 'https://sandbox.e2b.app'), timeout_s?: number (default 3600) }`; secrets `{ api_key }`. The key never leaves agentry-sandbox.
- E2B API (header `X-API-Key: <api_key>`):
  - create `POST /v2/sandboxes` body `{ templateID, timeout, autoPause: true, metadata: { 'agentry.sandbox.id': id, 'agentry.sandbox.owner': owner }, envVars?, allow_internet_access }` → `{ sandboxID, envdAccessToken, envdVersion, domain }`;
  - get `GET /sandboxes/{id}` (`state`: `running` | `paused`; 404 → missing);
  - pause `POST /sandboxes/{id}/pause` (204; 409 already pausing → treat as done; 503 → retry once after 2 s, then fail);
  - resume `POST /v2/sandboxes/{id}/connect` body `{ timeout }` (200/201);
  - extend `POST /sandboxes/{id}/timeout` body `{ timeout }`;
  - kill `DELETE /sandboxes/{id}` (204; 404 = already gone);
  - list `GET /v2/sandboxes?metadata=<urlencoded agentry.sandbox.id present>&state=running,paused` with `X-Next-Token` paging (filter `agentry.sandbox.id` client-side).
  - 429 → error "E2B rate limit; retry after <Retry-After> s" (no automatic retry loops).
- envd: base URL `sandbox_host`; every request carries `E2b-Sandbox-Id: <sandboxID>`, `E2b-Sandbox-Port: 49983`, and `X-Access-Token: <envdAccessToken>` (the driver's token replaces the HMAC token).
- Capabilities: `persistent: true`, `reset: true` (kill + create), `isolated: true`, `network: true` (`allow_internet_access` from `spec.network !== false`), `resources: false`, `gpu: false`, `envdBuiltIn: true`, `runsAsRoot: true`; template fields `packages`, `setupCommands`, `env`, `network`, `files` (no `image`: a 400 naming it, "E2B uses templates; set the place's template").
- The handle stores `e2bId`; `envdAccessToken` goes to the sandbox's encrypted `handleSecrets` (plan 1 storage).

## Review Focus

1. **E2B's timeout expires mid-use** → the sandbox is paused (auto-pause), not killed; the next request resumes it (Task 2 test `a paused sandbox resumes on the next request`).
2. **A long relayed session** → `maintain` extends the timeout while the sandbox is in use, so it isn't paused under the user (Task 2 test `maintain extends the timeout of a running sandbox`).
3. **E2B answers 429 or 503** → a clear error, no tight retry loop (Task 2 test `rate limit surfaces Retry-After`).
4. **The sandbox was deleted on E2B's side** → status `missing`, reconcile marks it failed as for other kinds; deleting it in Agentry succeeds (Task 2 test `a sandbox gone on E2B is missing and deletes cleanly`).
5. **The envd token never reaches a client** → the relay sends E2B's token upstream and never returns it (Task 1 test `the relay adds driver headers and the driver token upstream only`).

---

### Task 1: envd endpoints with HTTPS and headers

**Files:**
- Modify: `src/places/driver.ts` (`envdEndpoint` returns `{ baseUrl; token?; headers?: Record<string, string>; release? }`), `src/envd/client.ts` (`EnvdClientOptions.headers?`, sent on every call, HTTPS URLs supported), `src/places/bootstrap.ts` (passes `headers` to its envd client), `src/http/relay.ts` (adds `headers` upstream; `https:` base URLs use `node:https`), `src/sandboxes.ts` (`endpoint()` passes `headers` through)
- Test: `tests/relay.spec.ts`, `tests/envd-client.spec.ts`

**Interfaces:** Produces the widened `envdEndpoint` and `createEnvdClient({ baseUrl, accessToken, headers? })`.
- [ ] **Step 1: Write failing tests** — `the relay adds driver headers and the driver token upstream only` (a fake upstream asserts `E2b-Sandbox-Id`, `E2b-Sandbox-Port`, `X-Access-Token`; the client response carries none of them), `the relay reaches an https upstream` (local self-signed server; the relay's https agent trusts it in the test only via a test hook, never by disabling verification in product code), `the envd client sends extra headers`.
- [ ] **Step 2: Run** `pnpm test tests/relay.spec.ts tests/envd-client.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: envd endpoints with https and per-place headers`

### Task 2: The `e2b` driver

**Files:**
- Create: `src/places/drivers/e2b.ts`, `tests/support/fake-e2b.ts` (a local HTTP server implementing the endpoints above with in-memory sandboxes, a fake envd health route under the sandbox host form, and knobs: fail next with 429/503, expire a sandbox to `paused`, delete a sandbox), `tests/e2b.spec.ts`, `tests/e2b.live.spec.ts` (skips unless `AGENTRY_SANDBOX_TEST_E2B_KEY`)
- Modify: `src/places/registry.ts` (`drivers['e2b']`), `src/main.ts`, `src/http/server.ts` (admin test for `e2b`: `probe` = `GET /v2/sandboxes?limit=1` with the key → ok/"E2B refused the API key"), `src/admin/index.html` (kind "E2B (hosted)": API key, template, timeout), `openapi/agentry-sandbox.yaml`, `README.md`, `CHANGELOG.md`

**Interfaces:**
- Produces: `createE2bDriver(place: { apiKey: string; template: string; apiUrl: string; sandboxHost: string; timeoutS: number }, deps?: { fetch?: typeof fetch }): Driver`; `e2bFactory(): DriverFactory`.
- Lifecycle mapping: `create` → create (+ store token); `start` → connect with `timeout_s`; `stop` → pause; `destroy` → kill (404 ok); `status` → get (`running` → running, `paused` → stopped, 404 → missing); `envdEndpoint` → `{ baseUrl: sandbox_host, token, headers }`; `maintain` → extend timeout to `timeout_s` when running; `listManaged` → list with the metadata filter.
- No host key, no tunnel, no `discoverGpus`.
- [ ] **Step 1: Write failing tests** — `create sends the template, auto-pause and metadata and keeps the token secret`, `a paused sandbox resumes on the next request`, `maintain extends the timeout of a running sandbox`, `rate limit surfaces Retry-After`, `a sandbox gone on E2B is missing and deletes cleanly`, `a template image is rejected naming the field`, `admin test reports a refused key`.
- [ ] **Step 2: Run** `pnpm test tests/e2b.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; the shared bootstrap copies DSH's runtime through envd as for every kind (E2B's default template is Debian with glibc; amd64).
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS (live suite skipped).
- [ ] **Step 5: Commit** `feat: E2B places`

### Task 3: Web wording

**Files (agentry-web worktree, branch from `develop`):** `src/ui/sandboxes/format.ts` (`e2b` → "E2B (hosted)"), `mock/agentry-mock.ts` (an `e2b` place, no GPUs), `CHANGELOG.md`; test `tests/unit/sandbox-format.spec.ts` (`e2b` wording).
- [ ] Steps: failing test → implement → `pnpm typecheck && pnpm vitest run --no-file-parallelism` → commit `feat: name E2B places in Runs on`.

---

## Self-review notes

- Spec § Kind: E2B covered (T2), plus confirmed facts: shared sandbox host with headers (T1), auto-pause against TTL kills (T2), template-only (T2). Builder's question 2 (driver token) uses plan 1's `handleSecrets` and the widened endpoint (T1).
- Limits (10 concurrent running on Hobby) are E2B's; a place's `maxRunning` (plan 1) lets the operator mirror them.
