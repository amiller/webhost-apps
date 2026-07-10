#!/usr/bin/env bash
# Deploy cart-share to a pod tee-daemon as a deno source tarball.
#
# cart-share reads the owner's REAL Amazon cart via OAUTH3_TOKEN (a scoped amazon:read cart
# token bound to the owner's identity subject). That token is a SECRET — it is never stored in
# this repo; pass it in the environment at deploy time. OAUTH3_BASE defaults to the prod oauth3.
#
#   OAUTH3_TOKEN=<scoped-cart-read-token> TEE_DAEMON_TOKEN=<daemon> bash deploy.sh
#   CVM=<staging-url> OAUTH3_TOKEN=... TEE_DAEMON_TOKEN=... bash deploy.sh   # staging
#
# Prod (pod.dstack.soc1024.com) is OPERATOR-RUN: no prod daemon token lives on the dev box.
set -euo pipefail

CVM="${CVM:-https://pod.dstack.soc1024.com}"
OAUTH3_BASE="${OAUTH3_BASE:-https://pod.dstack.soc1024.com/oauth3}"
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "${TEE_DAEMON_TOKEN:-}" ] && [ -f "$HOME/.tee-daemon-staging.env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.tee-daemon-staging.env"
fi
: "${TEE_DAEMON_TOKEN:?no TEE_DAEMON_TOKEN — set it or source ~/.tee-daemon-staging.env}"
: "${OAUTH3_TOKEN:?no OAUTH3_TOKEN — pass the scoped cart-read token (never hardcode it)}"

MANIFEST=$(OAUTH3_BASE="$OAUTH3_BASE" OAUTH3_TOKEN="$OAUTH3_TOKEN" python3 - <<'PY'
import json, os
print(json.dumps({
  "name": "cart-share",
  "runtime": "deno",
  "entry": "server.ts",
  "mode": "dev",
  "listen": {"port": 8080, "protocol": "http"},
  "env": {"OAUTH3_BASE": os.environ["OAUTH3_BASE"], "OAUTH3_TOKEN": os.environ["OAUTH3_TOKEN"]},
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
