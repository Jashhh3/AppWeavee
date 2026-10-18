#!/bin/sh
set -eu
SECRETS_FILE="${APPWEAVE_SECRETS_FILE:-/data/secrets.env}"
mkdir -p "$(dirname "$SECRETS_FILE")"
# Persist generated secrets in the mounted Docker volume. Existing values always win.
if [ -f "$SECRETS_FILE" ]; then
  set -a
  . "$SECRETS_FILE"
  set +a
else
  JWT_SECRET="${JWT_SECRET:-$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")}" 
  AI_ENCRYPTION_KEY="${AI_ENCRYPTION_KEY:-$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")}" 
  umask 077
  {
    printf 'JWT_SECRET=%s\n' "$JWT_SECRET"
    printf 'AI_ENCRYPTION_KEY=%s\n' "$AI_ENCRYPTION_KEY"
  } > "$SECRETS_FILE"
  set -a
  . "$SECRETS_FILE"
  set +a
  echo "AppWeave initialized persistent secrets in $SECRETS_FILE"
fi
export JWT_SECRET AI_ENCRYPTION_KEY
exec "$@"
