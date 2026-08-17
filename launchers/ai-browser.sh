#!/usr/bin/env bash
# AI Browser - a normal Chromium that records everything.
#
# Run this, use the browser however you like, and any MCP client can
# discover it later and inspect what happened - including traffic from
# before the agent connected.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$ROOT/dist/cli.js" ]; then
  echo "browserd is not built yet:"
  echo "  cd '$ROOT' && npm install && npm run build"
  exit 1
fi

exec node "$ROOT/dist/cli.js" open --profile default ${1:+--url "$1"}
