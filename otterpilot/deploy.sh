#!/usr/bin/env bash
# Deploy otterpilot to the pod tee-daemon as a deno source tarball. Two secrets travel
# only in the deploy POST's manifest env, read from local files so nothing is committed:
#   OAUTH3_TOKEN — an owner-minted, otter-scoped token (see README "Mint the token").
#                  This is what makes otterpilot headless: no browser extension needed.
#   NEAR_KEY     — your NEAR AI Cloud key (the recap engine).
#
#   bash deploy.sh                 # deploy/redeploy
#   OAUTH3_TOKEN=... bash deploy.sh
set -euo pipefail
CVM="${CVM:-https://pod.dstack.soc1024.com}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TEE_DAEMON_TOKEN="${TEE_DAEMON_TOKEN:-$(grep -E '^TEE_DAEMON_TOKEN=' "$HOME/projects/hermes-agent/deploy-notes/.env.prod9" | cut -d= -f2-)}"
: "${TEE_DAEMON_TOKEN:?no daemon token}"

# otter-scoped token: env override, else local file (see README to mint one).
TOKFILE="$HOME/.claude/otterpilot-oauth3-token"
if [ -z "${OAUTH3_TOKEN:-}" ] && [ -s "$TOKFILE" ]; then OAUTH3_TOKEN=$(head -1 "$TOKFILE"); fi
: "${OAUTH3_TOKEN:?no OAUTH3_TOKEN — mint an otter token (see README) into $TOKFILE}"

# NEAR AI Cloud key (recap engine).
if [ -z "${NEAR_KEY:-}" ]; then NEAR_KEY=$(grep -E '^NEAR_KEY=' "$HOME/projects/aishley/.env.local" | cut -d= -f2-); fi
: "${NEAR_KEY:?no NEAR_KEY}"

export OAUTH3_TOKEN NEAR_KEY
MANIFEST=$(python3 - <<'PY'
import json,os
print(json.dumps({
  "name":"otterpilot","runtime":"deno","entry":"server.ts","mode":"dev",
  "listen":{"port":8080,"protocol":"http"},
  "env":{
    "OAUTH3_NODE":"https://pod.dstack.soc1024.com/oauth3",
    "OAUTH3_TOKEN":os.environ["OAUTH3_TOKEN"],
    "NEAR_KEY":os.environ["NEAR_KEY"],
    "NEAR_MODEL":"deepseek-ai/DeepSeek-V4-Flash",
    "NEAR_VL_MODEL":"google/gemini-2.5-flash"}}))
PY
)

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
tar czf "$TMP/app.tgz" -C "$DIR" server.ts project.json public
# The daemon echoes the full manifest (incl. secrets) on success — print only safe fields.
RESP=$(curl -fsS -X POST "$CVM/_api/projects" \
  -H "Authorization: Bearer $TEE_DAEMON_TOKEN" \
  -F "manifest=$MANIFEST;type=application/json" \
  -F "files=@$TMP/app.tgz")
echo "$RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("deployed:",d["name"],"| mode:",d.get("mode"),"| tree:",d.get("tree_hash","")[:12],"| at:",d.get("deployed_at"))'
echo "Deployed → $CVM/otterpilot/   (redeploy: re-run this script)"
