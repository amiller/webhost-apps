#!/usr/bin/env bash
# Deploy cart-share to a pod tee-daemon as a deno source tarball.
#
# TOKENLESS: cart-share holds NO oauth3 credential. The owner's browser gets a scoped, revocable
# amazon read token from the OAuth3 extension at runtime (window.oauth3.connect → POST /connect).
# So this deploy carries NO secret — the only token here is the daemon token to upload the tarball.
# OAUTH3_BASE (the oauth3 node URL, not a secret) defaults to the prod oauth3.
#
#   TEE_DAEMON_TOKEN=<daemon> bash deploy.sh
#   CVM=<staging-url> TEE_DAEMON_TOKEN=... bash deploy.sh          # staging
#
# Prod (pod.dstack.soc1024.com) is OPERATOR-RUN: no prod daemon token lives on the dev box.
set -euo pipefail

CVM="${CVM:-https://pod.dstack.soc1024.com}"
OAUTH3_BASE="${OAUTH3_BASE:-https://pod.dstack.soc1024.com/oauth3}"
DIR="$(cd "$(dirname "$0")" && pwd)"

# Daemon token: env override, else the prod deploy-notes env (CVM defaults to prod). For a
# staging deploy pass TEE_DAEMON_TOKEN / CVM explicitly.
ENVF="${ENVF:-$HOME/projects/hermes-agent/deploy-notes/.env.hermes-prod}"
if [ -z "${TEE_DAEMON_TOKEN:-}" ] && [ -f "$ENVF" ]; then
  TEE_DAEMON_TOKEN=$(grep -m1 '^TEE_DAEMON_TOKEN=' "$ENVF" | cut -d= -f2-)
fi
: "${TEE_DAEMON_TOKEN:?no TEE_DAEMON_TOKEN — set it or ensure $ENVF exists}"

MANIFEST=$(OAUTH3_BASE="$OAUTH3_BASE" python3 - <<'PY'
import json, os
print(json.dumps({
  "name": "cart-share",
  "runtime": "deno",
  "entry": "server.ts",
  "mode": "dev",
  "listen": {"port": 8080, "protocol": "http"},
  "env": {"OAUTH3_BASE": os.environ["OAUTH3_BASE"]},
}))
PY
)

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
tar czf "$TMP/app.tgz" -C "$DIR" server.ts project.json public

RESP=$(curl -fsS -X POST "$CVM/_api/projects" \
  -H "Authorization: Bearer $TEE_DAEMON_TOKEN" \
  -F "manifest=$MANIFEST;type=application/json" \
  -F "files=@$TMP/app.tgz")
echo "$RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("deployed:",d["name"],"| mode:",d.get("mode"),"| tree:",d.get("tree_hash","")[:12],"| at:",d.get("deployed_at"))' 2>/dev/null || echo "$RESP"
echo "Live → $CVM/cart-share/   (GET that to confirm 200 + the page paints)"
