#!/bin/sh
# Builds what the service needs from plain settings, then starts it.
#   AGENTRY_SANDBOX_KEY        -> AGENTRY_SANDBOX_API_KEYS  (the service stores only the SHA-256 hash)
#   AGENTRY_SANDBOX_ADMIN_KEY  -> AGENTRY_SANDBOX_ADMIN_KEYS
#   POSTGRES_PASSWORD (+ POSTGRES_HOST/PORT/USER/DB) -> AGENTRY_SANDBOX_DATABASE_URL
# Anything set explicitly wins, so a deployment can still pass hashes and a URL itself.
set -eu
hash() { printf 'sha256:%s' "$(printf %s "$1" | sha256sum | cut -d' ' -f1)"; }
if [ -z "${AGENTRY_SANDBOX_API_KEYS:-}" ] && [ -n "${AGENTRY_SANDBOX_KEY:-}" ]; then
  AGENTRY_SANDBOX_API_KEYS=$(hash "$AGENTRY_SANDBOX_KEY"); export AGENTRY_SANDBOX_API_KEYS
fi
if [ -z "${AGENTRY_SANDBOX_ADMIN_KEYS:-}" ] && [ -n "${AGENTRY_SANDBOX_ADMIN_KEY:-}" ]; then
  AGENTRY_SANDBOX_ADMIN_KEYS=$(hash "$AGENTRY_SANDBOX_ADMIN_KEY"); export AGENTRY_SANDBOX_ADMIN_KEYS
fi
unset AGENTRY_SANDBOX_KEY AGENTRY_SANDBOX_ADMIN_KEY
if [ -z "${AGENTRY_SANDBOX_DATABASE_URL:-}" ] && [ -n "${POSTGRES_PASSWORD:-}" ]; then
  enc=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$POSTGRES_PASSWORD")
  AGENTRY_SANDBOX_DATABASE_URL="postgres://${POSTGRES_USER:-agentry}:${enc}@${POSTGRES_HOST:-127.0.0.1}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-agentry_sandbox}"
  export AGENTRY_SANDBOX_DATABASE_URL
fi
cd /app
exec tsx src/main.ts
