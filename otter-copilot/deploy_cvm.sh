#!/bin/bash
# Deploy otter copilot to Andrew's running tee-daemon CVM (hermes-staging) as a Layer-1 image.
# Secrets passed INLINE via manifest.env (the working mechanism used by matrix-greeter/feedling-web).
# env_passthrough is NOT usable here: it forwards from the DAEMON's own CVM env, which never
# received the otter secrets (would require a disruptive daemon redeploy).
set -euo pipefail

CVM="https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network"
NAME="otter"
IMAGE="ghcr.io/amiller/teexai-otter:latest"
PORT=8137

DAEMON_TOKEN="$(grep '^TEE_DAEMON_TOKEN=' "$HOME/projects/hermes-agent/deploy-notes/.env.staging" | cut -d= -f2-)"

OTTER_ENV="$HOME/projects/ic3camp-teexai/teexai-transcribe/otter-integration/.env.local"
get_otter() { grep "^$1=" "$OTTER_ENV" | cut -d= -f2-; }
MATRIX_HOMESERVER="$(get_otter MATRIX_HOMESERVER)"
MATRIX_ROOM="$(get_otter MATRIX_ROOM)"
MATRIX_USER="$(get_otter MATRIX_USER)"
MATRIX_PASSWORD="$(get_otter MATRIX_PASSWORD)"
OWNER_TOKEN="$(get_otter OWNER_TOKEN)"
NEAR_API_KEY="$(grep '^NEAR_API_KEY=' "$HOME/projects/ic3camp-teexai/.env" | cut -d= -f2-)"
# Owner's existing authorized-user Google token (calendar.readonly + drive.readonly), injected inline.
GOOGLE_TOKEN_JSON="$(cat "$HOME/projects/teleport/planning/scripts/calendar_token_personal.json")"

read -r OTTER_SESSIONID OTTER_CSRFTOKEN <<<"$(python3 -c "import browser_cookie3 as bc; j={c.name:c.value for c in bc.chrome(domain_name='otter.ai')}; print(j['sessionid'], j['csrftoken'])")"

export OTTER_SESSION=sealed HOST=0.0.0.0 OTTER_OUT=/data/otter
export BASE_URL="$CVM/$NAME"
export OTTER_SESSIONID OTTER_CSRFTOKEN NEAR_API_KEY GOOGLE_TOKEN_JSON \
       MATRIX_HOMESERVER MATRIX_ROOM MATRIX_USER MATRIX_PASSWORD OWNER_TOKEN

# Build the manifest in ONE python step that reads os.environ directly — avoids re-embedding
# secret JSON (e.g. GOOGLE_TOKEN_JSON) into a bash-interpolated python literal.
MANIFEST="$(NAME="$NAME" IMAGE="$IMAGE" PORT="$PORT" python3 - <<'PY'
import json, os
keys = ["OTTER_SESSION","HOST","OTTER_OUT","BASE_URL",
        "OTTER_SESSIONID","OTTER_CSRFTOKEN","NEAR_API_KEY","GOOGLE_TOKEN_JSON",
        "MATRIX_HOMESERVER","MATRIX_ROOM","MATRIX_USER","MATRIX_PASSWORD","OWNER_TOKEN"]
print(json.dumps({
  "name": os.environ["NAME"],
  "runtime": "image",
  "image": os.environ["IMAGE"],
  "image_port": int(os.environ["PORT"]),
  "volumes": [{"name": "otter-data", "mount": "/data"}],
  "env": {k: os.environ[k] for k in keys},
}))
PY
)"

echo "Deploying $NAME (image=$IMAGE port=$PORT) to $CVM ..."
[ "${1:-}" = "--force" ] && curl -sf -X DELETE -H "Authorization: Bearer $DAEMON_TOKEN" "$CVM/_api/projects/$NAME" >/dev/null 2>&1 && echo "(deleted existing)" || true

RESP="$(curl -s -X POST -H "Authorization: Bearer $DAEMON_TOKEN" \
  -H "Content-Type: application/json" -d "$MANIFEST" "$CVM/_api/projects")"
echo "Deploy response: $RESP"
