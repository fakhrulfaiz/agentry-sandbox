# Agentry Sandbox — agent guide

`CLAUDE.md` is a symlink to this file; edit `AGENTS.md`.

## What this is

A standalone service that creates hardened Docker sandboxes on demand. Every sandbox runs E2B's open-source `envd` (Apache-2.0, pinned, unmodified), and callers reach it only through this service's authenticated relay. The Agentry API (`~/code/dsh-agents-api`) uses it as its `sandbox` environment provider; the web app never talks to it directly.

Design: `~/code/agentry-web/docs/superpowers/specs/2026-11-25-agentry-sandbox-design.md`. Plan 1: `~/code/agentry-web/docs/superpowers/plans/2026-11-25-agentry-sandbox-service.md`.

## Rules

- Never add `Co-Authored-By` or any AI attribution to commits or PRs. Commit as `fakhrulfaiz <fakhrulfaiz2003@gmail.com>`.
- Never modify the DeepSeek Harness repo. Never fork `envd`: pin it, and if it must change, keep a small patch applied at build time.
- Never publish envd's port 49983 on a non-loopback address. Every envd call carries `X-Access-Token` = `hex(HMAC-SHA256(secret, sandboxId))`; the token is never stored.
- Containers are hardened: default seccomp, `CapDrop: ALL` + a short `CapAdd` list, not privileged, no bind mounts, no Docker socket, pids/cpu/memory limits. Optional gVisor through `AGENTRY_SANDBOX_RUNTIME=runsc`.
- Network: per-owner bridge with inter-container traffic off; egress to the internet only (host, LAN, private ranges, metadata blocked).
- Every record and container is owner-scoped; another owner's id answers 404.
- Exact dependency versions; update `CHANGELOG.md` with every behaviour change.

## Commands

- Prefix shells with `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH` (Node 24, pnpm 11).
- `pnpm test` (Vitest; Docker suites skip when Docker is absent) · `pnpm typecheck` · `pnpm gen` (regenerate the envd client) · `pnpm images:build` (envd + default sandbox images) · `pnpm dev`.
- Run the dev server in herdr, never a pop-up terminal: `hc run --bg --no-parent --outlive-parent --name agentry-sandbox -- pnpm dev`.
- Image pulls and builds use a credential-free Docker config (the Windows credential helper fails in WSL).
