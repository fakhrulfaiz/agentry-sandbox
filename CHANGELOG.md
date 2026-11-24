# Changelog

## Unreleased

- 2026-11-25: Project created: configuration from the environment (`src/config.ts`), with named startup errors for missing or invalid values.
- 2026-11-25: `agentry/envd:envd-v0.6.13` image (E2B envd built unmodified from the pinned commit, with its Apache-2.0 license) and `agentry/sandbox:1` default image (Debian, Node 24, pnpm, Python with the Office packages, `agent` user with passwordless sudo, `/workspace`). envd's API spec vendored in `third_party/envd` (`pnpm images:build`, `scripts/vendor-envd-spec.sh`).
