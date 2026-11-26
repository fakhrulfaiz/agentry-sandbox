# Agentry Sandbox in Docker

The published image is `ghcr.io/fakhrulfaiz/agentry-sandbox-service` (the service itself; not
`agentry-sandbox`, which is the default sandbox base image, nor `agentry-envd`). Run it with Postgres
using `compose.yaml`:

```
cp agentry-sandbox.env.example .env     # set POSTGRES_PASSWORD, AGENTRY_SANDBOX_KEY, AGENTRY_SANDBOX_SECRET
docker compose up -d
curl http://127.0.0.1:3090/v1/health    # {"ok":true}
```

Then give the Agentry API `AGENTRY_SANDBOX_URL` (`http://host.docker.internal:3090` from the API's
container) and the same `AGENTRY_SANDBOX_KEY`. The Agentry API and Agentry Web composes can also start it
(`COMPOSE_PROFILES=sandbox`).

## The Docker socket

The service creates, starts, stops and deletes containers, so the container mounts the host's
`/var/run/docker.sock`. That is root on the host for whoever holds it, which is acceptable here because:

- only this service holds it: it is not passed on. The sandboxes it creates run with no Docker socket, no
  bind mounts, no privileges, all capabilities dropped and CPU, memory and process limits;
- the service takes requests only with a key, and every record and container is scoped to its owner;
- it runs as root in the container on purpose (a non-root user would need the host's `docker` group id
  and gains nothing, since the socket is root-equivalent);
- to avoid mounting the socket at all, run the service on a machine you dedicate to it, or point it at
  a remote Docker host (a "Docker over SSH" place on the admin page) or at E2B.

It uses the host network (Linux), so it can reach each sandbox's envd port on `127.0.0.1` and install the
egress firewall rules in the host's namespace. Docker Desktop (macOS, Windows) does not support this:
run the service from source there (`pnpm dev`).

## Settings

`AGENTRY_SANDBOX_KEY` and `AGENTRY_SANDBOX_ADMIN_KEY` are plain keys here; the entrypoint stores their
SHA-256 hashes in `AGENTRY_SANDBOX_API_KEYS` / `_ADMIN_KEYS` (set those yourself to override).
`POSTGRES_PASSWORD` (with `POSTGRES_HOST`, `_PORT`, `_USER`, `_DB`) builds the database URL unless
`AGENTRY_SANDBOX_DATABASE_URL` is set. Every other `AGENTRY_SANDBOX_*` variable is in the main README.
Migrations run at startup.

## Build and CI

`docker build -t agentry-sandbox-service .` (a credential-free `DOCKER_CONFIG` in WSL). Pull requests to
`main` check that the image builds and that `package.json`'s version is not yet released; the merge to
`main` publishes the image and a GitHub Release (`.github/workflows/publish.yml`).
