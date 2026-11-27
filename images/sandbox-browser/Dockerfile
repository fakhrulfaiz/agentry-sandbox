# The browser-enabled sandbox image: the standard image plus Playwright MCP and
# Chromium. It is opt-in, for agents with "Web browser" turned on. Built from the
# standard image tag so both images always share the same base software; envd is
# still injected by the service, not baked in.
FROM ghcr.io/fakhrulfaiz/agentry-sandbox:1

ARG NODE_VERSION=24.21.0
ARG PNPM_VERSION=11.28.5
ARG PLAYWRIGHT_MCP_VERSION=0.0.80

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# Pinned to the version DSH pins. Chromium lives in a shared, read-only folder.
# envd processes do not get image ENV, so the API's browser bridge passes
# PLAYWRIGHT_BROWSERS_PATH itself (Playwright still writes its own state under
# ~/.cache/ms-playwright, which must stay writable: do not link it here).
RUN npm install -g "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && node "$(npm root -g)/@playwright/mcp/node_modules/playwright-core/cli.js" install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && chmod -R a+rX /opt/ms-playwright \
 && playwright-mcp --version

# Repeat the standard labels so the Providers page lists this image's software.
LABEL org.agentry.runtimes="{\"node\":\"${NODE_VERSION}\",\"pnpm\":\"${PNPM_VERSION}\",\"python\":\"3.11\"}" \
      org.agentry.python-packages="numpy pandas python-dateutil python-docx python-pptx openpyxl Pillow lxml XlsxWriter" \
      org.agentry.tools="git curl jq build-essential sudo chromium playwright-mcp"
