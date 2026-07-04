#!/bin/bash
# Deploy feedling-web to hermes-staging CVM via tarball upload (no GitHub).
# Usage: ./deploy.sh [--force]
set -euo pipefail

CVM="https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network"
PROJECT_NAME="feedling-web"
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/.env"
DAEMON_TOKEN="${DAEMON_TOKEN:-$(grep TEE_DAEMON_TOKEN "$HOME/projects/hermes-agent/deploy-notes/.env.staging" | cut -d= -f2)}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Copy .env.example to .env and fill in values."
  exit 1
fi

declare -A SECRETS
while IFS='=' read -r key val; do
  [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
  SECRETS[$key]="$val"
done < "$ENV_FILE"

# Force BASE_PATH to match the deploy name
SECRETS[BASE_PATH]="/$PROJECT_NAME"

echo "Loaded ${#SECRETS[@]} credentials from .env"

TARBALL="$(mktemp --suffix=.tar.gz)"
trap 'rm -f "$TARBALL"' EXIT
tar -czf "$TARBALL" -C "$HERE" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./.env' \
  --exclude='./subs.json' \
  .
echo "tarball: $(du -h "$TARBALL" | cut -f1)"

ENV_JSON=$(
  for key in "${!SECRETS[@]}"; do
    val="${SECRETS[$key]}"
    val="${val//\\/\\\\}"
    val="${val//\"/\\\"}"
    printf '"%s":"%s"\n' "$key" "$val"
  done | paste -sd ',' -
)

MANIFEST="{\"name\":\"$PROJECT_NAME\",\"runtime\":\"deno\",\"entry\":\"server.ts\",\"attested\":false,\"env\":{$ENV_JSON},\"source\":\"tarball://$PROJECT_NAME\",\"ref\":\"local\",\"listen\":{\"port\":0,\"protocol\":\"http\"}}"

FORCE="${1:-}"
if [ "$FORCE" = "--force" ]; then
  echo "Deleting existing $PROJECT_NAME project..."
  curl -sf -X DELETE \
    -H "Authorization: Bearer $DAEMON_TOKEN" \
    "$CVM/_api/projects/$PROJECT_NAME" || echo "(not found, ok)"
fi

echo "Deploying $PROJECT_NAME via multipart upload..."
RESPONSE=$(curl -sf -X POST \
  -H "Authorization: Bearer $DAEMON_TOKEN" \
  -F "manifest=$MANIFEST;type=application/json" \
  -F "files=@$TARBALL;type=application/gzip" \
  "$CVM/_api/projects")
echo "Deployed: $RESPONSE"

echo "Waiting 25s for runtime to restart..."
sleep 25
STATUS=$(curl -sf "$CVM/$PROJECT_NAME/" 2>/dev/null | head -c 200 || echo "NOT READY")
echo "Status snippet: $STATUS"
echo "Visit: $CVM/$PROJECT_NAME/"
