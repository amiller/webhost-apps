#!/bin/bash
# Deploy twitter-debug ATTESTED with NET_ADMIN → the baked-in vpn.sh brings up ProtonVPN.
# Run once the daemon is back up (needs the netadmin daemon image live).
#   ZAI_API_KEY=... ./deploy-attested.sh
set -euo pipefail
DAEMON="https://pod.dstack.soc1024.com"
TOKEN=$(grep -E '^TEE_DAEMON_TOKEN=' ~/projects/hermes-agent/deploy-notes/.env.prod9 | cut -d= -f2-)
SEC=~/projects/teleport/login-with-anything/deploy/secrets.env
OU=$(grep -E '^OPENVPN_USER=' "$SEC" | cut -d= -f2-)
OP=$(grep -E '^OPENVPN_PASS=' "$SEC" | cut -d= -f2-)
OC=$(grep -E '^OVPN_CONFIG_BASE64=' "$SEC" | cut -d= -f2-)
DS=$(cat "$(dirname "$0")/.debug-secret")   # gates writes/posting + browser-driving
: "${ZAI_API_KEY:?set ZAI_API_KEY}"
EMPTY=$(mktemp -u).tgz; tar czf "$EMPTY" -T /dev/null
MANIFEST=$(python3 -c "
import json,os
print(json.dumps({'name':'twitter-debug','runtime':'image','image':'ghcr.io/amiller/tiktok-dstack:twitter-debug',
 'image_port':3000,'oci_runtime':'runc','mode':'attested','caps':['NET_ADMIN'],
 'env':{'ZAI_API_KEY':os.environ['ZAI_API_KEY'],'OPENVPN_USER':'''$OU''','OPENVPN_PASS':'''$OP''','OVPN_CONFIG_BASE64':'''$OC''','DEBUG_SECRET':'''$DS'''}}))")
curl -s -X POST "$DAEMON/_api/projects" -H "Authorization: Bearer $TOKEN" \
  -F "manifest=${MANIFEST};type=application/json" -F "files=@${EMPTY}" | python3 -m json.tool
