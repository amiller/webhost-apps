#!/usr/bin/env bash
# Deploy cart-share to a tee-daemon CVM as a deno source tarball.
#
# cart-share reads the owner's Amazon cart via the oauth3 CONNECT handshake (issue #58): the
# owner approves Amazon read on the OAuth3 consent page; cart-share polls for the scoped token
# (bound to the approver) and reads /api/amazon/items. No pre-minted OAUTH3_TOKEN — the only
# config it needs is OAUTH3_BASE, the oauth3 node beside this CVM.
#
#   source ~/.tee-daemon-staging.env && CVM="$TEE_DAEMON_URL" OAUTH3_BASE="$WEBHOST_STAGING/oauth3" bash deploy.sh
#   CVM=https://pod.dstack.soc1024.com bash deploy.sh     # prod — OPERATOR-RUN (no prod token here)
set -euo pipefail

CVM="${CVM:-https://pod.dstack.soc1024.com}"
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "${TEE_DAEMON_TOKEN:-}" ] && [ -f "$HOME/.tee-daemon-staging.env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.tee-daemon-staging.env"
fi
: "${TEE_DAEMON_TOKEN:?no TEE_DAEMON_TOKEN — set it or source ~/.tee-daemon-staging.env}"
# The oauth3 node that lives beside the target CVM. cart-share's connect + cart read both hit it.
: "${OAUTH3_BASE:=$CVM/oauth3}"

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
echo "Live → $CVM/cart-share/   (GET that to confirm 200 + the page)"
