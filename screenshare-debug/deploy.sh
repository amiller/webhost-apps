# screenshare-debug — deploy to the pod tee-daemon as a deno source tarball.
#
# No secrets are required. Optional env:
#   OAUTH3_NODE — the oauth3 node for identity (default the pod; override for staging).
#
#   bash deploy.sh
set -euo pipefail
CVM="${CVM:-https://pod.dstack.soc1024.com}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TEE_DAEMON_TOKEN="${TEE_DAEMON_TOKEN:-$(grep -E '^TEE_DAEMON_TOKEN=' "$HOME/projects/hermes-agent/deploy-notes/.env.prod9" 2>/dev/null | cut -d= -f2- || true)}"
if [ -z "$TEE_DAEMON_TOKEN" ] && [ -f "$HOME/.tee-daemon-staging.env" ]; then
  . "$HOME/.tee-daemon-staging.env"
fi
: "${TEE_DAEMON_TOKEN:?no daemon token — set TEE_DAEMON_TOKEN or source ~/.tee-daemon-staging.env}"

export OAUTH3_NODE="${OAUTH3_NODE:-https://pod.dstack.soc1024.com/oauth3}"
MANIFEST=$(python3 - <<'PY'
import json,os
print(json.dumps({"name":"screenshare-debug","runtime":"deno","entry":"server.ts","mode":"dev",
  "listen":{"port":8080,"protocol":"http"},"env":{"OAUTH3_NODE":os.environ["OAUTH3_NODE"]}}))
PY
)

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
tar czf "$TMP/app.tgz" -C "$DIR" server.ts project.json public
RESP=$(curl -fsS -X POST "$CVM/_api/projects" \
  -H "Authorization: Bearer $TEE_DAEMON_TOKEN" \
  -F "manifest=$MANIFEST;type=application/json" \
  -F "files=@$TMP/app.tgz")
echo "$RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("deployed:",d["name"],"| mode:",d.get("mode"),"| tree:",d.get("tree_hash","")[:12],"| at:",d.get("deployed_at"))'
echo "Deployed → $CVM/screenshare-debug/   (redeploy: re-run this script)"
