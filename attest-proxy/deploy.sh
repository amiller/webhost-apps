#!/usr/bin/env bash
# Deploy attest-proxy to a tee-daemon CVM.
#
#   TEE_DAEMON_TOKEN=... CVM=https://pod.dstack.soc1024.com bash deploy.sh
#
# The Anthropic key and the invite token travel only in the deploy POST's
# manifest, never in the committed source. Env values are redacted on the
# daemon's public verifier path (ingress.py _api_status), so promoting this
# project does not expose them.
set -euo pipefail
: "${TEE_DAEMON_TOKEN:?set TEE_DAEMON_TOKEN}"
: "${CVM:?set CVM=https://your-cvm}"
DIR="$(cd "$(dirname "$0")" && pwd)"

# Invite token gates session creation. This endpoint is reachable from the
# internet and spends a real key, so the app refuses to open sessions at all
# when it is unset. Generated once and kept locally so it never lands in a
# transcript.
TOKF="$HOME/.claude/attest-proxy-invite-token"
if [ -z "${SESSION_TOKEN:-}" ]; then
  [ -s "$TOKF" ] || { umask 077; openssl rand -hex 16 > "$TOKF"; }
  SESSION_TOKEN=$(cat "$TOKF")
fi

# Without a real key the app runs but every relay fails at the upstream. Keep
# the placeholder explicit rather than pretending it is configured.
KEY="${ANTHROPIC_API_KEY:-skip}"
MAX_CALLS="${MAX_CALLS:-50}"

umask 077
TGZ=$(mktemp --suffix=.tgz); MF=$(mktemp)
tar czf "$TGZ" -C "$DIR" server.ts project.json
SESSION_TOKEN="$SESSION_TOKEN" KEY="$KEY" MAX_CALLS="$MAX_CALLS" python3 -c "
import json, os
print(json.dumps({'name':'attest-proxy','runtime':'deno',
  # 'public' controls whether the project shows in the daemon's unauthenticated
  # listing. It does NOT control reachability — an unlisted project is still
  # served at its path, which is why session creation is gated separately.
  'public': os.environ.get('PUBLIC','1') == '1',
  'env':{
  'ANTHROPIC_API_KEY': os.environ['KEY'],
  'SESSION_TOKEN':     os.environ['SESSION_TOKEN'],
  'MAX_CALLS':         os.environ['MAX_CALLS']}}))" > "$MF"

curl -sS -m 180 -X POST "$CVM/_api/projects" \
  -H "Authorization: Bearer $TEE_DAEMON_TOKEN" \
  -F "manifest=@$MF;type=application/json" -F "files=@$TGZ" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('deployed', d['name'], 'tree_hash', d['tree_hash'])"
rm -f "$TGZ" "$MF"

echo "landing: $CVM/attest-proxy/"
echo "invite token is in $TOKF"
