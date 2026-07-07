#!/usr/bin/env bash
# Deploy calendar-share to a pod tee-daemon as a deno source tarball.
#
# calendar-share has NO server-side secrets: the scoped write:event:<id> token lives in the
# share URL the owner mints, and the owner-path read token comes from the OAuth3 extension
# (or the in-browser wallet). So unlike otterpilot this carries no OAUTH3_TOKEN / NEAR_KEY —
# the only credential here is the daemon token to upload the tarball.
#
#   bash deploy.sh                          # deploy to the default CVM (prod pod)
#   CVM=<staging-url> bash deploy.sh        # deploy to staging for verify
#   TEE_DAEMON_TOKEN=... bash deploy.sh     # override the daemon token
#
# Prod (pod.dstack.soc1024.com, the app's real home — the oauth3 node beside it has the
# google-calendar plugin + the cube@ jar) is OPERATOR-RUN: no prod daemon token lives on
# this box. To verify static serving on staging instead:
#   source ~/.tee-daemon-staging.env && CVM="$TEE_DAEMON_URL" bash deploy.sh
set -euo pipefail

CVM="${CVM:-https://pod.dstack.soc1024.com}"
DIR="$(cd "$(dirname "$0")" && pwd)"

# Daemon token: env override, else the box's staging env file (see box-inventory). Prod
# deploys set TEE_DAEMON_TOKEN inline.
if [ -z "${TEE_DAEMON_TOKEN:-}" ] && [ -f "$HOME/.tee-daemon-staging.env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.tee-daemon-staging.env"
fi
: "${TEE_DAEMON_TOKEN:?no TEE_DAEMON_TOKEN — set it or source ~/.tee-daemon-staging.env}"

MANIFEST=$(python3 - <<'PY'
import json
print(json.dumps({
  "name": "calendar-share",
  "runtime": "deno",
  "entry": "server.ts",
  "mode": "dev",
  "listen": {"port": 8080, "protocol": "http"},
  "env": {"OAUTH3_NODE": "https://pod.dstack.soc1024.com/oauth3"},
}))
PY
)

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
tar czf "$TMP/app.tgz" -C "$DIR" server.ts project.json public

# The daemon echoes the full manifest on success — print only safe fields.
RESP=$(curl -fsS -X POST "$CVM/_api/projects" \
  -H "Authorization: Bearer $TEE_DAEMON_TOKEN" \
  -F "manifest=$MANIFEST;type=application/json" \
  -F "files=@$TMP/app.tgz")
echo "$RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("deployed:",d["name"],"| mode:",d.get("mode"),"| tree:",d.get("tree_hash","")[:12],"| at:",d.get("deployed_at"))' 2>/dev/null || echo "$RESP"
echo "Live → $CVM/calendar-share/   (GET that to confirm 200 + the page)"
