# Agentry Sandbox service (the process that creates and relays the sandboxes), not the sandbox base image
# (images/sandbox, ghcr.io/fakhrulfaiz/agentry-sandbox) and not envd.
# Build: docker build -t agentry-sandbox-service .
# Run:   see docker/README.md. It needs Postgres, its keys, and the host's Docker socket
#        (-v /var/run/docker.sock:/var/run/docker.sock), because it drives Docker.
# No configuration is baked in: everything comes from AGENTRY_SANDBOX_* variables at start.

FROM node:24.19.0-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11.21.0 tsx@4.23.15 --no-fund --no-audit && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
COPY migrations ./migrations
COPY openapi ./openapi
COPY third_party/envd/LICENSE third_party/envd/NOTICE.md ./third_party/envd/
COPY docker/entrypoint.sh /opt/agentry/entrypoint.sh
# Runs as root on purpose: the Docker socket is root-equivalent whoever opens it, so a
# non-root user would only add a group id to match per host (see docker/README.md).
ENV NODE_ENV=production AGENTRY_SANDBOX_HOST=0.0.0.0 AGENTRY_SANDBOX_PORT=3090
EXPOSE 3090
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AGENTRY_SANDBOX_PORT||3090)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/agentry/entrypoint.sh"]
