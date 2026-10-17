#!/usr/bin/env sh
set -eu
"$(dirname "$0")/bootstrap-env.sh"
docker compose up --build -d
docker compose ps
printf '%s\n' 'Dashboard: http://localhost:8080' 'API health: http://localhost:3000/health'
