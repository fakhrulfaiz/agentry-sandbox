# Agentry Sandbox: what it is

Agentry Sandbox is a small service that creates **isolated Linux machines on demand** and lets the Agentry API run commands and move files in them. It does not run agents. The Agentry API (`dsh-agents-api`) runs DeepSeek Harness (DSH); when a chat is attached to a sandbox, DSH's tools (bash, file edits, search, jobs, subagents) run inside the sandbox instead of on the API host.

```
Agentry Web (browser)  →  Agentry API (DeepSeek Harness)  →  Agentry Sandbox (this service)  →  a sandbox
 UI only, no credentials     sessions, environments,            authenticates, enforces limits,     container / VM
                             templates; talks to the service    relays to the sandbox's envd
                             with a server-side key
```

Browsers never talk to this service. The API holds the service key, and the service holds the secret that every sandbox's access token derives from.

## What it does

- **Creates and manages sandboxes** for an *owner* (a user): create, start, stop, reset, delete, list. Idle sandboxes are stopped (not deleted) after `AGENTRY_SANDBOX_IDLE_MINUTES`.
- **Runs them on a *place***: Docker on this host, Docker over SSH, a Linux machine over SSH, or hosted E2B (see [Places](#places-and-drivers)).
- **Applies a template**: image, system / Python / npm packages, setup commands, environment variables, starter files, network on or off, CPU and memory, GPUs (what a place supports).
- **Keeps a workspace disk** per sandbox. It survives stop and start, and Reset keeps it where the place allows.
- **Enforces limits**: sandboxes per owner, running at once, creates per hour, CPU and memory (see the README). Going over answers `429 quota_exceeded` with the reason. An admin page (`/admin`) shows everything and changes limits live.
- **Guards the network**: sandboxes get outbound internet only; private networks are blocked, and nothing can connect in. There is no SSH and no published port.
- **Relays envd** (below) so callers can run commands, open terminals and read or write files, authenticated per owner.

## The pieces inside a sandbox

| Piece | Where | What it is |
|---|---|---|
| **envd** | its own daemon, port 49983 | E2B's open-source in-sandbox daemon (Apache-2.0, built unmodified from a pinned commit). The service injects it into every sandbox, so any image works as a template (E2B sandboxes ship it already). |
| **DSH runtime** | `/opt/agentry/dsh` | DeepSeek Harness's remote helper plus a Node runtime, injected the same way (see [below](#the-deepseek-harness-helper)). |
| **agent user** | the sandbox's OS | A user named `agent` with passwordless sudo (except on a machine over SSH, where the agent is the SSH login user). |
| **workspace** | `/workspace` on new sandboxes | The sandbox's working disk. Files here show in the web app's Files list. |
| **home** | `/home/agent` | Ordinary home: `pip --user` packages, dotfiles. Not shown in the Files list. |

The default image (`ghcr.io/fakhrulfaiz/agentry-sandbox:1`) is Debian with Python 3, Node 24, pnpm, git, sudo and build tools. Packages, setup commands and installed software live in the container's own disk: they survive stop and start but not delete or Reset (Reset rebuilds the container from its template and keeps the workspace).

### envd: how callers use a sandbox

envd speaks Connect-RPC over HTTP. The service exposes it at `/v1/sandboxes/{id}/envd/*` behind the owner's authentication and the sandbox's own token, so the sandbox never needs an open port. Its services are:

- `process`: start a command (`sandbox_exec`), run an interactive shell with a PTY (the terminals), send input and resize.
- `filesystem`: list, stat, read, write and remove files (Files list, uploads, `sandbox_pull` and `sandbox_push`).
- a file endpoint for the raw bytes.

### The DeepSeek Harness helper

DSH normally runs its tools on the machine it lives on. To run them somewhere else, DSH has *remote providers* for files, processes, terminals and run_code that talk to a small helper process over SSH. We do not use SSH. Instead:

1. The `dsh-runtime` image (`images/dsh-runtime`) holds the helper unmodified from npm (`@deepseek-ai/dsh-ssh`, plus `@deepseek-ai/dsh-ptc-runtime-node` and a Node binary) under `/opt/agentry/dsh`, with a `manifest.json` that records the helper's and the PTC bootstrap's SHA-256 digests.
2. When a sandbox is first provisioned, the service copies that tree into it (as root, atomically, skipped when the same version is already there).
3. When a chat starts, the Agentry API starts the helper through envd (`node /opt/agentry/dsh/.../helper.js`). DSH's requests travel over the helper's stdin and stdout, carried by envd. Program output streams go through small envd processes that pipe to the helper's Unix socket, authenticated end to end with the helper's TLS-PSK key.
4. The API checks the helper's digest against `manifest.json` on every connection, and refuses a mismatch.

That helper is why a chat on a sandbox runs *entirely inside it*: DSH on the host asks the helper to read a file, start bash or open a terminal, and the helper does it in the sandbox. Without it (`AGENTRY_SANDBOX_DSH_RUNTIME_IMAGE=none`) a sandbox still takes commands and files, but the API's DSH tools cannot run there.

## Places and drivers

A **place** is one concrete place sandboxes can run; a **driver** is the code for one kind of place. A driver makes the machine and gets envd reachable; the shared bootstrap (`src/places/bootstrap.ts`) then provisions every kind the same way (agent user, packages, files, setup commands, DSH runtime).

| Kind | What it runs on | Isolation | Reset keeps files |
|---|---|---|---|
| Docker | this host | container wall (default seccomp, dropped capabilities, no bind mounts, limits) | yes |
| Docker over SSH | a remote Docker host | same | yes |
| Machine over SSH | a Linux machine, no container | **none**: the agent is the SSH user, with that user's sudo | no reset |
| E2B (hosted) | E2B's cloud | E2B's | no (reset deletes files) |

Places are added on the admin page, not in the web app: they need credentials (SSH private keys, an E2B key) the browser must not hold. See [`docs/superpowers/specs/2026-11-25-sandbox-backends-design.md`](superpowers/specs/2026-11-25-sandbox-backends-design.md) for the design and each place's limits. To support another provider (for example Daytona), write a driver in `src/places/drivers/` that implements `Driver` (`src/places/driver.ts`) and gets envd reachable inside the sandbox.

## How the Agentry API uses it

- The API's `sandbox` provider maps *environments* to sandboxes. An environment is one sandbox plus its record (name, template, place); a *template* is a saved setup; a *provider* is a kind of backend (`local` or `sandbox`).
- A chat attached to a sandbox environment runs its DSH tools there. Any chat can also manage sandboxes through the `sandbox_*` tools (create, exec, start, stop, delete, `sandbox_pull`, `sandbox_push`); creating or deleting asks the user first.
- The web app shows environments, templates, providers and places, starts and stops sandboxes, browses files, and opens terminals, all through the API.

## Using it from other tools (MCP)

Any MCP client (Claude Code, Cursor, another harness) can use the same sandboxes:

1. On the admin page, **Access keys**: create a key for a user. It is shown once and stored only as a hash. Use the same user name as in Agentry to share that user's sandboxes and limits.
2. Point the client at `http://<host>:<port>/mcp` (streamable HTTP, JSON responses) with `Authorization: Bearer <key>`. For Claude Code: `claude mcp add --transport http sandbox http://<host>:<port>/mcp --header "Authorization: Bearer <key>"`.
3. Tools: `sandbox_list`, `sandbox_create`, `sandbox_start`, `sandbox_stop`, `sandbox_delete`, `sandbox_exec`, `sandbox_read_file`, `sandbox_write_file`.

A key acts only as its owner, on `/v1` as well as `/mcp`. The endpoint calls this service's own public API with the caller's key, so limits, the egress guard and per-owner scoping apply as for any caller. A sandbox made through MCP is a plain sandbox: it appears on the admin page, but Agentry Web lists *environments* (records in the Agentry API), so it does not show there unless the API adopts it. Interactive terminals are not offered over MCP.

## What it does not do

- No SSH or inbound ports into a sandbox. Snapshots are described in the README ("Snapshots").
- No Daytona or Modal places yet.
- Machine-over-SSH places are not isolated; E2B resets delete all files.
- It does not run DeepSeek Harness itself, store chats, or hold user accounts: owners come from the Agentry API.
