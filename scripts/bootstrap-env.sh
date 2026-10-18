#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE="$ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then : > "$ENV_FILE"; fi
get_value() { key="$1"; sed -n "s/^${key}=//p" "$ENV_FILE" | sed -n '1p'; }
set_value() { key="$1"; value="$2"; if grep -q "^${key}=" "$ENV_FILE"; then sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"; else printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"; fi; }
secret() { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }
JWT=$(get_value JWT_SECRET || true); case "$JWT" in ''|replace-with*|change-me*) set_value JWT_SECRET "$(secret)";; esac
AI=$(get_value AI_ENCRYPTION_KEY || true); case "$AI" in ''|replace-with*|change-me*) set_value AI_ENCRYPTION_KEY "$(secret)";; esac
[ -n "$(get_value ALLOWED_ORIGINS || true)" ] || set_value ALLOWED_ORIGINS 'http://localhost:8080,http://127.0.0.1:8080'
[ -n "$(get_value VITE_API_URL || true)" ] || set_value VITE_API_URL 'http://localhost:3000'
printf '%s\n' "AppWeave environment is ready: $ENV_FILE" "Secrets are generated only when missing; existing secrets are preserved."
