#!/usr/bin/env bash
# Deploy the goodpoint-box LANDING (page only, ahead of the #80 app) to the PROD pod.
# RUN YOURSELF from the laptop (prod secrets are laptop-only):
#   ! bash goodpoint-box/deploy-landing.sh
# Serves: pod.dstack.soc1024.com/goodpoint-box/  -> the landing
# The full app (#80) later redeploys under the same name and replaces this.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROD_SECRETS="$HOME/.oauth3-prod-secrets.env"
CVM="https://3ab6b2ac28625aaaff0943cb4fd0cf13227760e1-8080.dstack-base-prod7.phala.network"
DOMAIN="https://pod.dstack.soc1024.com"
[ -s "$PROD_SECRETS" ] || { echo "no $PROD_SECRETS (prod deploys are laptop-only)"; exit 1; }
DTOKEN=$(grep -E "^TEE_DAEMON_TOKEN=" "$PROD_SECRETS" | head -1 | cut -d= -f2-)
: "${DTOKEN:?no TEE_DAEMON_TOKEN in prod secrets}"

BUILD=$(mktemp -d); trap 'rm -rf "$BUILD"' EXIT
cat > "$BUILD/server.pod.js" <<'EOF'
export default async function handler(req) {
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  if (path === "/") {
    return new Response(await Deno.readTextFile(new URL("./landing.html", import.meta.url)),
      { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response("not yet — the combined app is being built: https://github.com/amiller/webhost-apps/issues/80\n", { status: 404 });
}
EOF
cp "$HERE/public/landing.html" "$BUILD/landing.html"
tar czf "$BUILD/goodpoint-box.tgz" -C "$BUILD" server.pod.js landing.html
MANIFEST='{"name":"goodpoint-box","runtime":"deno","entry":"server.pod.js","mode":"dev","public":true,"env":{}}'

echo "POSTing goodpoint-box (landing) to prod pod..."
RESP=$(curl -sf -X POST "$CVM/_api/projects" -H "Authorization: Bearer $DTOKEN" \
  -F "manifest=$MANIFEST;type=application/json" \
  -F "files=@$BUILD/goodpoint-box.tgz;type=application/gzip")
echo "deploy response: ${RESP:0:200}"

for i in $(seq 1 12); do
  sleep 5
  code=$(curl -s -o /dev/null -w "%{http_code}" "$DOMAIN/goodpoint-box/")
  echo "  t+$((i*5))s /goodpoint-box/ = $code"
  [ "$code" = "200" ] && { echo "LANDING LIVE: $DOMAIN/goodpoint-box/"; exit 0; }
done
echo "not serving after 60s — check daemon logs"; exit 1
