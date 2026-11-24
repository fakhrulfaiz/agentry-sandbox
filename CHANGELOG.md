# Changelog

## Unreleased

- 2026-11-25: Project created: configuration from the environment (`src/config.ts`), with named startup errors for missing or invalid values.
- 2026-11-25: `agentry/envd:envd-v0.6.13` image (E2B envd built unmodified from the pinned commit, with its Apache-2.0 license) and `agentry/sandbox:1` default image (Debian, Node 24, pnpm, Python with the Office packages, `agent` user with passwordless sudo, `/workspace`). envd's API spec vendored in `third_party/envd` (`pnpm images:build`, `scripts/vendor-envd-spec.sh`).
- 2026-11-25: Generated envd client (`src/envd/client.ts`, Connect-RPC `process`/`filesystem` plus `/health`, `/init`, `/files`), per-sandbox access tokens derived as HMAC-SHA256 of the sandbox id (`src/envd/token.ts`, never stored), and envd extraction from its image as a tar for any container (`src/backends/envd-binary.ts`). Verified against a live envd: process streaming with exit codes, file round-trip, and calls with a wrong token refused.
- 2026-11-25: Sandbox and template store: Postgres (`migrations/0001_init.sql`, forward-only migrations under an advisory lock) and an in-memory store for tests, both owner-scoped and checked by one shared contract test.
