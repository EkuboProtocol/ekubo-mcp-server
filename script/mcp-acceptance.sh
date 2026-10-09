#!/bin/sh
# Small-model acceptance run for the live /mcp/ekubo catalog, using the Cloud
# Wallet harness (cloud-wallet scripts/mcp-acceptance.ts). The Cloud Wallet
# catalog is added because handoff scenarios end in wallet tools.
# CLOUD_WALLET_DIR: a cloud-wallet checkout with dependencies installed
# (default ../cloud-wallet). MCP_URL: the endpoint (default production).
# Extra arguments go to the harness, e.g. --cf, --models, --only, --out.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
cloud_wallet=${CLOUD_WALLET_DIR:-$here/../cloud-wallet}
exec npm --prefix "$cloud_wallet" run --silent test:mcp-acceptance -- \
  --catalog "${MCP_URL:-https://mcp.ekubo.org/mcp/ekubo}" \
  --catalog cloud-wallet \
  --scenarios "$here/test/mcp-acceptance/scenarios.json" \
  "$@"
