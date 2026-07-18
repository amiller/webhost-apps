#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HOME/.tee-daemon-staging.env" ]; then . "$HOME/.tee-daemon-staging.env"; fi
CVM="${CVM:-${WEBHOST_STAGING:-${TEE_DAEMON_URL:-}}}"
: "${CVM:?set CVM or WEBHOST_STAGING}"
: "${TEE_DAEMON_TOKEN:?set TEE_DAEMON_TOKEN or source ~/.tee-daemon-staging.env}"
: "${GOOGLE_SERVICE_ACCOUNT_JSON:?set GOOGLE_SERVICE_ACCOUNT_JSON from the vault; never commit a key}"

export GOOGLE_SERVICE_ACCOUNT_JSON
MANIFEST="$(python3 - <<'PY'
import json, os
print(json.dumps({"name":"agent-calendar","runtime":"deno","entry":"server.ts","mode":"dev","listen":{"port":8080,"protocol":"http"},"env":{"VERSION":os.environ.get("VERSION","development"),"GOOGLE_CALENDAR_ID":os.environ.get("GOOGLE_CALENDAR_ID","primary"),"GOOGLE_SERVICE_ACCOUNT_JSON":os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]}}))
PY
)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
tar czf "$TMP/app.tgz" -C "$DIR" server.ts project.json public
RESP="$(curl -fsS -X POST "$CVM/_api/projects" -H "Authorization: Bearer $TEE_DAEMON_TOKEN" -F "manifest=$MANIFEST;type=application/json" -F "files=@$TMP/app.tgz")"
echo "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("deployed:",d["name"],"| tree:",d.get("tree_hash","")[:12],"| at:",d.get("deployed_at"))'
echo "Live → $CVM/agent-calendar/"
