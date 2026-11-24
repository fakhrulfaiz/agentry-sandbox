# Agentry's default sandbox image. envd is not baked in: the service injects it
# into every container, so any image works as a template.
FROM debian:bookworm-slim

ARG NODE_VERSION=24.21.0
ARG PNPM_VERSION=11.28.5

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git sudo build-essential python3 python3-pip python3-venv \
      unzip xz-utils procps less nano jq \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
 && npm install -g "pnpm@${PNPM_VERSION}" \
 && node -v && pnpm -v

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
      org.agentry.tools="git curl jq build-essential sudo"
