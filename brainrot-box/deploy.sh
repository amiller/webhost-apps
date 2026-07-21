#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HOME/.tee-daemon-staging.env" ]; then . "$HOME/.tee-daemon-staging.env"; fi
if [ -f "$HOME/paseo-batch/.intake-env" ]; then . "$HOME/paseo-batch/.intake-env"; fi

CVM="${CVM:-${WEBHOST_STAGING:-${TEE_DAEMON_URL:-}}}"
: "${CVM:?set CVM or WEBHOST_STAGING}"
: "${TEE_DAEMON_TOKEN:?set TEE_DAEMON_TOKEN or source ~/.tee-daemon-staging.env}"
: "${OAUTH3_CORE:?set OAUTH3_CORE or source ~/paseo-batch/.intake-env}"
: "${OTTER_TOKEN:?set OTTER_TOKEN or source ~/paseo-batch/.intake-env}"
: "${NEAR_API_KEY:?set NEAR_API_KEY}"
: "${CHUTES_API_KEY:?set CHUTES_API_KEY}"
# Attestation pins (webhost-apps#105): derive once with
#   ./attest-verify/target/release/attest-verify --derive-pins <model>
# and review the values out-of-band before trusting them.
: "${NEAR_KMS_ROOTS:?set NEAR_KMS_ROOTS (see --derive-pins)}"
: "${NEAR_BASE_MEASUREMENTS:?set NEAR_BASE_MEASUREMENTS (see --derive-pins)}"

MANIFEST="$(python3 - <<'PY'
import json, os
print(json.dumps({
  "name": "goodpoint-box",
  "runtime": "deno",
  "entry": "server.ts",
  "mode": "dev",
  "listen": {"port": 8080, "protocol": "http"},
  "env": {
    "OAUTH3_CORE": os.environ["OAUTH3_CORE"],
    "OTTER_TOKEN": os.environ["OTTER_TOKEN"],
    "NEAR_API_KEY": os.environ["NEAR_API_KEY"],
    "CHUTES_API_KEY": os.environ["CHUTES_API_KEY"],
    "TOOLSMITH_MODEL": os.environ.get("TOOLSMITH_MODEL", "deepseek-ai/DeepSeek-V4-Flash"),
    "COMPOSITOR_MODEL": os.environ.get("COMPOSITOR_MODEL", "unsloth/Mistral-Nemo-Instruct-2407-TEE"),
    "COMPOSITOR_BASE_URL": os.environ.get("COMPOSITOR_BASE_URL", ""),
    "COMPOSITOR_API_KEY": os.environ.get("COMPOSITOR_API_KEY", ""),
    "NEAR_KMS_ROOTS": os.environ["NEAR_KMS_ROOTS"],
    "NEAR_BASE_MEASUREMENTS": os.environ["NEAR_BASE_MEASUREMENTS"],
    **{k: os.environ[k] for k in ("NEAR_WORKLOAD_IDS", "NEAR_IMAGE_DIGESTS") if os.environ.get(k)},
  },
}))
PY
)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar czf "$TMP/app.tgz" -C "$DIR" server.ts near_e2ee.ts chutes_e2ee.ts hosted_stream.ts project.json public ca-bundle.crt \
  -C "$DIR/attest-verify/target/release" attest-verify
RESP="$(curl -fsS -X POST "$CVM/_api/projects" \
  -H "Authorization: Bearer $TEE_DAEMON_TOKEN" \
  -F "manifest=$MANIFEST;type=application/json" \
  -F "files=@$TMP/app.tgz")"
echo "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("deployed:", d["name"], "| mode:", d.get("mode"), "| tree:", d.get("tree_hash", "")[:12], "| at:", d.get("deployed_at"))'
echo "Deployed -> $CVM/goodpoint-box/app"
