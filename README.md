# Agentry Sandbox

Hardened Docker sandboxes on demand for Agentry agents. Each sandbox runs E2B's `envd` (processes, PTYs, files) and is reached only through this service.

Setup, configuration and the security model are documented in `AGENTS.md`; the full design lives in the Agentry Web repo (`docs/superpowers/specs/2026-11-25-agentry-sandbox-design.md`).

## Third-party

`envd` and its API spec (`third_party/envd/`) come from [e2b-dev/runtime](https://github.com/e2b-dev/runtime) under the Apache License 2.0; see `third_party/envd/LICENSE` and `NOTICE.md`.
