#!/usr/bin/env bash
# Builds the envd image and the default sandbox image. Uses a credential-free
# Docker config so the Windows credential helper (Docker Desktop on WSL) cannot
# break pulls of public base images.
set -euo pipefail
cd "$(dirname "$0")/.."
cfg=$(mktemp -d)
trap 'rm -rf "$cfg"' EXIT
echo '{}' > "$cfg/config.json"
export DOCKER_CONFIG=$cfg
docker build -t ghcr.io/fakhrulfaiz/agentry-envd:envd-v0.6.13 images/envd
docker build -t ghcr.io/fakhrulfaiz/agentry-dsh-runtime:0.2.2-rc.1 images/dsh-runtime
docker build -t ghcr.io/fakhrulfaiz/agentry-sandbox:1 images/sandbox
docker build -t ghcr.io/fakhrulfaiz/agentry-netguard:1 images/netguard
