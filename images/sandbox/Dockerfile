# Agentry's default sandbox image. envd is not baked in: the service injects it
# into every container, so any image works as a template.
FROM debian:bookworm-slim

ARG TARGETARCH
ARG NODE_VERSION=24.21.0
ARG PNPM_VERSION=11.28.5
ARG PLAYWRIGHT_MCP_VERSION=0.0.80

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git sudo build-essential python3 python3-pip python3-venv \
      unzip xz-utils procps less nano jq \
 && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH:-amd64}" in arm64) NODE_ARCH=arm64 ;; *) NODE_ARCH=x64 ;; esac \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
 && npm install -g "pnpm@${PNPM_VERSION}" \
 && node -v && pnpm -v

# The web browser for agents that have it turned on: Playwright MCP (pinned, the
# version DSH pins) and the Chromium build its Playwright expects, with the
# system libraries Chromium needs. Browsers live in a shared, read-only folder.
# envd processes do not get image ENV, so the API's browser bridge passes
# PLAYWRIGHT_BROWSERS_PATH itself (Playwright still writes its own state under
# ~/.cache/ms-playwright, which must stay writable: do not link it here).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && node "$(npm root -g)/@playwright/mcp/node_modules/playwright-core/cli.js" install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && chmod -R a+rX /opt/ms-playwright \
 && playwright-mcp --version

RUN pip install --no-cache-dir --break-system-packages \
      numpy pandas python-dateutil python-docx python-pptx openpyxl Pillow lxml XlsxWriter

RUN useradd -m -u 1000 -s /bin/bash agent \
 && printf 'agent ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/agent \
 && chmod 0440 /etc/sudoers.d/agent \
 && mkdir -p /workspace \
 && chown agent:agent /workspace

WORKDIR /workspace

# What the image ships, read by Agentry Sandbox for the Providers page. Debian bookworm's python3 is 3.11.
LABEL org.agentry.runtimes="{\"node\":\"${NODE_VERSION}\",\"pnpm\":\"${PNPM_VERSION}\",\"python\":\"3.11\"}" \
      org.agentry.python-packages="numpy pandas python-dateutil python-docx python-pptx openpyxl Pillow lxml XlsxWriter" \
      org.agentry.tools="git curl jq build-essential sudo chromium playwright-mcp"
