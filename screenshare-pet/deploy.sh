#!/usr/bin/env bash
# screenshare-pet — deploy to the webhost-staging tee-daemon as a deno source tarball.
#
# No secrets are required: the pet keeps ALL authorization machinery out (issue #73). The only
# server-side surface beyond the static client is two clearly-labelled DEV-ONLY loopback
# endpoints (/dev/echo, /dev/caption) used when the operator ticks the in-page "debug: mirror
# to sink" toggle — they store nothing and require no credential. VERSION is pinned to the
# current git commit so a Tier-1 transcript can assert the deployed tree is the PR under review.
#
#   bash deploy.sh
set -euo pipefail
CVM="${CVM:-https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network}"
DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="${VERSION:-$(git -C "$DIR" rev-parse --short=12 HEAD 2>/dev/null || echo local)}"
if [ -z "${TEE_DAEMON_TOKEN:-}" ] && [ -f "$HOME/.tee-daemon-staging.env" ]; then
  . "$HOME/.tee-daemon-staging.env"
fi
: "${TEE_DAEMON_TOKEN:?no daemon token — source ~/.tee-daemon-staging.env or set TEE_DAEMON_TOKEN}"

export VERSION
MANIFEST=$(python3 - <<'PY'
import json, os
print(json.dumps({"name":"screenshare-pet","runtime":"deno","entry":"server.ts","mode":"dev",
  "listen":{"port":8080,"protocol":"http"},"env":{"VERSION":os.environ["VERSION"]}}))
PY
)

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
tar czf "$TMP/app.tgz" -C "$DIR" server.ts project.json public
RESP=$(curl -fsS -X POST "$CVM/_api/projects" \
  -H "Authorization: Bearer $TEE_DAEMON_TOKEN" \
  -F "manifest=$MANIFEST;type=application/json" \
  -F "files=@$TMP/app.tgz")
echo "$RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("deployed:",d["name"],"| version:",d.get("env",{}).get("VERSION",""),"| tree:",d.get("tree_hash","")[:12],"| at:",d.get("deployed_at"))'
echo "Deployed → $CVM/screenshare-pet/   (redeploy: re-run this script)"
