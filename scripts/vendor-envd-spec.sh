#!/usr/bin/env bash
# Copies envd's API spec and license from the pinned upstream commit into
# third_party/envd (fetched inside a container, so no host git access is needed).
set -euo pipefail
cd "$(dirname "$0")/.."
TAG=envd-v0.6.13
COMMIT=2acf2d51bd1e2fe146914f24c44f7ee07d2213c5
cfg=$(mktemp -d); trap 'rm -rf "$cfg"' EXIT; echo '{}' > "$cfg/config.json"; export DOCKER_CONFIG=$cfg
out=third_party/envd
mkdir -p "$out/spec/process" "$out/spec/filesystem"
docker run --rm -v "$PWD/$out:/out" --entrypoint sh alpine/git:latest -c "
  set -e
  git clone -q --depth 1 --branch $TAG https://github.com/e2b-dev/runtime.git /r
  cd /r && test \"\$(git rev-parse HEAD)\" = $COMMIT
  cp LICENSE /out/LICENSE
  cp packages/envd/spec/process/process.proto /out/spec/process/process.proto
  cp packages/envd/spec/filesystem/filesystem.proto /out/spec/filesystem/filesystem.proto
  cp packages/envd/spec/envd.yaml /out/spec/envd.yaml
  chown -R $(id -u):$(id -g) /out
"
printf 'repository: https://github.com/e2b-dev/runtime\ntag: %s\ncommit: %s\npath: packages/envd/spec\n' "$TAG" "$COMMIT" > "$out/UPSTREAM"
