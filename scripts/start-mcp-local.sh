#!/usr/bin/env sh
set -eu
# Deliberately development-only: this exposes an unauthenticated MCP endpoint on localhost.
NODE_ENV=development APPWEAVE_MCP_LOCAL_TEST_MODE=true docker compose up --build "$@"
