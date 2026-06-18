#!/usr/bin/env bash
# Deploy router-dashboard to a tee-daemon CVM. Reads the instance keys from
# ~/.claude/router-simulcast.json at run time so secrets never get committed or
# pasted anywhere. The keys travel only in the deploy POST's manifest env.
#
#   TEE_DAEMON_TOKEN=...  CVM=https://your-cvm.dstack.phala.network  bash deploy.sh
set -euo pipefail
: "${TEE_DAEMON_TOKEN:?set TEE_DAEMON_TOKEN}"
: "${CVM:?set CVM=https://your-cvm.dstack.phala.network}"
CFG="${SIMULCAST_CONFIG:-$HOME/.claude/router-simulcast.json}"
DIR="$(cd "$(dirname "$0")" && pwd)"

# View token unlocks private plaintext. Generated once and kept locally so it
# never lands in a transcript; override by exporting VIEW_TOKEN.
TOKFILE="$HOME/.claude/router-dashboard-view-token"
if [ -z "${VIEW_TOKEN:-}" ]; then
  [ -s "$TOKFILE" ] || { umask 077; openssl rand -hex 16 > "$TOKFILE"; }
  VIEW_TOKEN=$(cat "$TOKFILE")
fi

# LLM for weekly highlights — OpenAI-compatible (ZAI default, or bitrouter/attested).
# Key from env or a local file you populate; absent ⇒ highlights show an enable hint.
#   ZAI:       LLM_BASE=https://api.z.ai/api/coding/paas/v4   LLM_MODEL=glm-4.6
#   bitrouter: LLM_BASE=https://api.bitrouter.ai/v1           LLM_MODEL=<model>
LLMFILE="$HOME/.claude/router-dashboard-llm-key"
if [ -z "${LLM_API_KEY:-}" ] && [ -s "$LLMFILE" ]; then LLM_API_KEY=$(head -1 "$LLMFILE"); fi
: "${LLM_BASE:=https://api.z.ai/api/coding/paas/v4}"
: "${LLM_MODEL:=glm-4.6}"
export INSTANCES VIEW_TOKEN LLM_API_KEY LLM_BASE LLM_MODEL

# Mark every instance private EXCEPT the public notebook (fail-closed).
INSTANCES=$(python3 - "$CFG" <<'PY'
import json,sys
c=json.load(open(sys.argv[1]))
conv=lambda i:{"name":i["name"],"base":i["url"].split("/mcp")[0],"key":i["url"].split("key=")[1],"private":i["name"]!="public","entryPath":"/e/{id}" if i["name"]=="public" else "/entry?id={id}"}
print(json.dumps([conv(i) for i in [c["primary"]]+c["secondaries"]]))
PY
)

MANIFEST=$(python3 - <<'PY'
import json,os
print(json.dumps({
  "name":"router-dashboard","runtime":"deno","entry":"server.ts","mode":"dev",
  "env":{k:v for k,v in {
         "INSTANCES":os.environ["INSTANCES"],
         "VIEW_TOKEN":os.environ["VIEW_TOKEN"],
         "LLM_API_KEY":os.environ.get("LLM_API_KEY",""),
         "LLM_BASE":os.environ.get("LLM_BASE",""),
         "LLM_MODEL":os.environ.get("LLM_MODEL",""),
         "REFRESH_MS":os.environ.get("REFRESH_MS","600000"),
         "LIMIT":os.environ.get("LIMIT","8000"),
         "ME":os.environ.get("ME","amiller")}.items() if v}}))
PY
)

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
tar czf "$TMP/app.tgz" -C "$DIR" server.ts project.json
# The daemon echoes the full manifest (incl. env secrets) on success — capture it
# and print only non-secret fields so secrets never hit stdout/logs.
RESP=$(curl -fsS -X POST "$CVM/_api/projects" \
  -H "Authorization: Bearer $TEE_DAEMON_TOKEN" \
  -F "manifest=$MANIFEST;type=application/json" \
  -F "files=@$TMP/app.tgz")
echo "$RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("deployed:",d["name"],"| mode:",d.get("mode"),"| tree:",d.get("tree_hash","")[:12],"| at:",d.get("deployed_at"))'
echo "Deployed → $CVM/router-dashboard/   (redeploy: re-run this script)"
