#!/bin/bash
# Build the image, push to ghcr, deploy as a runtime=image project on the tee-daemon.
#   TEE_DAEMON_TOKEN=... ZAI_API_KEY=... ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
IMG="ghcr.io/amiller/tiktok-dstack:twitter-debug"   # public tag (bakes private src; see POD-APPS-AUDIT)
DAEMON="${DAEMON_URL:-https://pod.dstack.soc1024.com}"
: "${TEE_DAEMON_TOKEN:?set TEE_DAEMON_TOKEN}" ; : "${ZAI_API_KEY:?set ZAI_API_KEY}"

echo "== build =="; docker build --load -t "$IMG" .
echo "== push  =="; docker push "$IMG"
echo "== deploy =="
EMPTY="$(mktemp -u).tgz"; tar czf "$EMPTY" -T /dev/null
MANIFEST=$(python3 -c "import json,os;print(json.dumps({'name':'twitter-debug','runtime':'image','image':'$IMG','image_port':3000,'oci_runtime':'runc','env':{'ZAI_API_KEY':os.environ['ZAI_API_KEY']}}))")
curl -s -X POST "$DAEMON/_api/projects" -H "Authorization: Bearer $TEE_DAEMON_TOKEN" \
  -F "manifest=${MANIFEST};type=application/json" -F "files=@${EMPTY}"
echo; echo "== live at $DAEMON/twitter-debug/ =="
