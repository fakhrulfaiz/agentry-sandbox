# Sandbox places, plan 2: the SSH machine kind

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A place kind `ssh-machine`: Agentry works directly on an existing Linux machine (its files, tools and GPUs) over SSH, with envd started there by passwordless sudo, reached through an SSH tunnel.

**Architecture:** A new driver in agentry-sandbox reuses plan 1's SSH helpers (pinned host key, tunnels) and the shared bootstrap. Over SSH it uploads envd for the machine's architecture, starts one envd per sandbox with `sudo -n` on a free loopback port, and tracks it in `~/.agentry/sandboxes/<id>/`. The bootstrap learns to run the agent as the login user on this kind; the relay maps `agent` to that user. Arch-aware image loading fixes the DSH runtime image for ARM.

**Tech Stack:** Node 24, TypeScript, ssh2 1.17.0 (SFTP + exec), dockerode (platform-specific pulls), vitest; agentry-web (Next.js, astryx).

**Spec:** `docs/superpowers/specs/2026-11-25-sandbox-backends-design.md` § Kind: SSH machine (revised 2026-11-25), § GPU sharing, § Builder's questions 7.

## Global Constraints

- Commits as `fakhrulfaiz <fakhrulfaiz2003@gmail.com>`; never `Co-Authored-By` or any AI attribution.
- `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`. agentry-sandbox: `pnpm typecheck`, `pnpm test` (Postgres suite via `AGENTRY_SANDBOX_TEST_DATABASE_URL`); agentry-web: `pnpm typecheck`, `pnpm vitest run --no-file-parallelism` (no e2e).
- Kind name `ssh-machine`. Config `{ url: 'ssh://user@host[:port]', host_key }`, secrets `{ private_key }` — identical to `docker-ssh` (reuse `parseSshTarget`, `sshConnectOptions`, `hostVerifier`, `createTunnels` from `src/places/ssh.ts`).
- Remote layout: `~/.agentry/bin/envd-envd-v0.6.13-<arch>` (mode 0755), `~/.agentry/sandboxes/<id>/meta.json` (`{"id","owner","workspace","port"}`), `envd.pid`, `envd.log`. `<arch>` ∈ `amd64` (`uname -m` x86_64), `arm64` (aarch64); anything else → create fails "unsupported architecture <uname -m>".
- envd command on the machine: `sudo -n <envd path> --isnotfc --no-cgroups --port <port>` (envd 0.6.13 has no listen-address flag: it listens on every interface).
- **Loopback-only, fail closed:** before starting envd, add `sudo -n iptables -I INPUT -p tcp --dport <port> ! -i lo -j DROP` and the same with `ip6tables` (comment `agentry-<id>` on each rule); remove them on stop/destroy. If `iptables` is missing or the rule fails, envd is not started and create/start fails "cannot restrict envd to loopback on <host>: <reason>". `ip6tables` may be missing only when the machine has no IPv6 (`/proc/net/if_inet6` empty). Rules are re-checked on every start.
- Free port: first port from `49300 + (hash(id) % 600)` upward that nothing listens on (`ss -ltn` or a `/dev/tcp` probe), recorded in `meta.json`.
- `probe`: SSH reachable with the pinned key, `sudo -n true` succeeds (else not ok: "passwordless sudo is required for <user>"), `uname -m` supported; GPUs via `nvidia-smi --query-gpu=index,uuid,name --format=csv,noheader` when present (reuse plan 1's CSV parser).
- `destroy` removes exactly the recorded workspace directory and `~/.agentry/sandboxes/<id>/` — and refuses (throws) when the recorded workspace path is `/`, empty, or not absolute.
- GPUs: assigned uuids reach envd's environment as `CUDA_VISIBLE_DEVICES=<uuid,uuid>`.
- Private keys never in logs, errors or responses; a host key mismatch stops every call (`HostKeyChangedError`).

## Review Focus

1. **The machine has no passwordless sudo** → the admin "Test connection" and the place state say so plainly; nothing is uploaded or started (Task 2 test `probe without sudo reports why`).
2. **A sandbox's envd died (machine rebooted)** → `status` says stopped, `start` relaunches envd on its port (or a new free one) and the workspace is still there (Task 2 test `start after a reboot relaunches envd`).
3. **The firewall rule cannot be added (no iptables)** → envd is never started, the error says why (Task 2 test `start adds the loopback-only rules …`).
4. **Destroy with a bad recorded path** → refuses, deletes nothing (Task 2 test `destroy refuses an unsafe workspace path`).
5. **Two sandboxes on one machine** → distinct ports, pids and dirs; stopping one leaves the other running (Task 2 test `two sandboxes on one machine are independent`).
6. **ARM machine** → envd and DSH runtime for arm64 are used, never the service host's arch (Task 1 test `loads envd for the requested platform`).

---

### Task 1: Arch-aware envd and DSH runtime (and the DSH runtime image on ARM)

**Files:**
- Modify: `src/backends/envd-binary.ts`, `images/dsh-runtime/Dockerfile`, `src/places/images.ts` (if pulls take a platform)
- Test: `tests/envd-binary.spec.ts` (create), `tests/images.spec.ts`

**Interfaces:**
- Produces: `loadEnvdBinary(docker, image, ensure?, platform?: 'linux/amd64' | 'linux/arm64'): Promise<Buffer>` and `treeArchive(docker, image, path, ensure?, platform?)` — cache key includes the platform; the throwaway container is created with that platform (`createContainer({ ..., platform })`), the image pulled for it when missing (`pull(image, { platform })`).
- `images/dsh-runtime/Dockerfile` picks the Node tarball by `TARGETARCH` (`x64` for amd64, `arm64` for arm64), like `images/sandbox`.
- [ ] **Step 1: Write failing tests** — `loads envd for the requested platform` (against the local Docker: build/pull the envd image for `linux/arm64` and `linux/amd64` if available — skip the test when the daemon cannot run that platform's create (`exec format` is fine; only `createContainer` + `getArchive` are needed) — assert the two binaries differ and the arm64 one starts with the ELF header and machine type 0xB7), `the dsh-runtime Dockerfile uses TARGETARCH` (text assertion like the existing image tests).
- [ ] **Step 2: Run** `pnpm test tests/envd-binary.spec.ts tests/images.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the platform parameter and the Dockerfile change.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `fix: arch-aware envd and DSH runtime loading; DSH runtime image for arm64`

### Task 2: The `ssh-machine` driver

**Files:**
- Create: `src/places/drivers/ssh-machine.ts`, `src/places/remote-shell.ts` (an `exec(cmd)` / SFTP helper over one pinned ssh2 connection per place, re-connected on demand, shared with the tunnels' connection logic where practical)
- Modify: `src/places/registry.ts` (`drivers['ssh-machine']`), `src/main.ts`, `src/places/bootstrap.ts`, `src/places/driver.ts`, `src/http/relay.ts`
- Test: `tests/ssh-machine.spec.ts` (in-process ssh2 `Server` with `exec` and `sftp` handlers backed by a temp directory and a fake process table — no real machine), `tests/bootstrap.spec.ts`

**Interfaces:**
- Consumes: `src/places/ssh.ts` (plan 1), `loadEnvdBinary(..., platform)` and `treeArchive(..., platform)` (Task 1), the bootstrap.
- Produces:
  - `Driver.agentUser?: string` — when set, the bootstrap runs everything it ran as `agent` as this user, skips `ensureAgent`'s user/sudoers creation (only `mkdir -p` + `chown` of the workspace), and ignores `spec.packages`.
  - `Driver.envdUser?(requested: string): string` — the relay applies it to `X-Envd-User` (ssh-machine: `agent` → login user, anything else unchanged).
  - `Driver.envdEnv?(handle): Record<string, string>` — extra envd environment for `/init` (ssh-machine: `CUDA_VISIBLE_DEVICES` from `handle.gpuIds`).
  - `createSshMachineDriver(config: SandboxConfig, place: { target: string; hostKey?: string; privateKey: string; allowUnpinnedProbe?: boolean }, deps?: { connect?: …; local?: Docker }): Driver` and `sshMachineFactory(config): DriverFactory`.
  - Capabilities per the spec section (template fields `setupCommands`, `env`, `files`, `gpus`).
- [ ] **Step 1: Write failing tests** — `probe without sudo reports why`, `probe reports GPUs from nvidia-smi`, `create uploads envd once per arch and starts it with sudo on a free port` (asserts the exact command string from Global Constraints and that a second create on the same arch skips the upload), `start after a reboot relaunches envd` (fake process table drops the pid), `destroy refuses an unsafe workspace path` (`/`, `''`, `relative`), `destroy removes only the recorded workspace and the sandbox dir`, `start adds the loopback-only rules before envd and refuses to start envd when they fail`, `stop removes the rules`, `two sandboxes on one machine are independent`, `the relay maps agent to the login user` (unit on `envdUser`), `bootstrap with agentUser creates no users and ignores packages`, `GPU assignment reaches CUDA_VISIBLE_DEVICES`.
- [ ] **Step 2: Run** `pnpm test tests/ssh-machine.spec.ts tests/bootstrap.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** (the loopback-only firewall rules from Global Constraints are part of start; stop and destroy remove them).
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: SSH machine places (envd with passwordless sudo)`

### Task 3: Admin page, API wording, web wording, docs

**Files:**
- Modify: `src/admin/index.html` (kind `ssh-machine` in the add form, plain words "Machine over SSH", the no-isolation warning and the passwordless-sudo requirement next to the kind), `openapi/agentry-sandbox.yaml` (kind enum), `README.md`, `CHANGELOG.md` (agentry-sandbox)
- Modify (agentry-web, worktree `~/code/places-wt/agentry-web`, branch from `develop`): `src/ui/sandboxes/format.ts` (`ssh-machine` → "Machine over SSH (no isolation)"), `mock/agentry-mock.ts` (a third place of kind `ssh-machine`, `reset: false`), `CHANGELOG.md`
- Test: `tests/admin.spec.ts` (page lists the kind and the warning), agentry-web `tests/unit/sandbox-format.spec.ts` (`ssh-machine` wording), `tests/component/runs-on-picker.spec.tsx` (a no-reset place hides Reset — only if not already covered)
- [ ] **Step 1: Write failing tests** as listed.
- [ ] **Step 2: Run** the focused tests — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** both repos' typecheck and full tests — Expected: PASS.
- [ ] **Step 5: Commit** in each repo: `feat: SSH machine places on the admin page` / `feat: name SSH machine places in Runs on`.

---

## Self-review notes

- Spec coverage: revised § SSH machine — sudo requirement and probe (T2), agent as login user + relay mapping (T2), upload/arch/ports/state files (T1, T2), stop/destroy/status/listManaged (T2), GPUs via CUDA_VISIBLE_DEVICES (T2), multi-arch images (T1), admin warning (T3). The API needs no change (capabilities and kinds pass through).
- Hardware we lack (a real SSH machine, GPUs) is replaced by an in-process ssh2 server with a fake shell; a real-machine check is in the operator's guide.
