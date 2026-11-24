#!/usr/bin/env bash
# Agentry Sandbox for development on http://127.0.0.1:3090 (admin page: /admin).
# Keys come from the Agentry API's git-ignored .env (override with AGENTRY_ENV_FILE):
#   AGENTRY_SANDBOX_KEY (the API's key), AGENTRY_SANDBOX_SECRET, AGENTRY_SANDBOX_ADMIN_KEY (optional).
# This service only ever sees the keys' SHA-256 hashes.
set -eo pipefail
export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE=${AGENTRY_ENV_FILE:-$HOME/code/dsh-agents-api/.env}
KEY=$(sed -n 's/^AGENTRY_SANDBOX_KEY=//p' "$ENV_FILE" | tail -1)
SECRET=$(sed -n 's/^AGENTRY_SANDBOX_SECRET=//p' "$ENV_FILE" | tail -1)
ADMIN=$(sed -n 's/^AGENTRY_SANDBOX_ADMIN_KEY=//p' "$ENV_FILE" | tail -1)
[ -n "$KEY" ] && [ -n "$SECRET" ] || { echo "set AGENTRY_SANDBOX_KEY and AGENTRY_SANDBOX_SECRET in $ENV_FILE" >&2; exit 1; }
hash() { printf 'sha256:%s' "$(printf %s "$1" | sha256sum | cut -d' ' -f1)"; }

if [ -z "${AGENTRY_SANDBOX_DATABASE_URL:-}" ]; then
  PGPASS=$(docker inspect agentry-postgres --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
  ENC=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PGPASS")
  export AGENTRY_SANDBOX_DATABASE_URL="postgres://agentry:${ENC}@127.0.0.1:55432/agentry_sandbox"
fi
export AGENTRY_SANDBOX_API_KEYS=$(hash "$KEY")
export AGENTRY_SANDBOX_SECRET=$SECRET
[ -n "$ADMIN" ] && export AGENTRY_SANDBOX_ADMIN_KEYS=$(hash "$ADMIN")
cd "$ROOT"
exec pnpm dev
