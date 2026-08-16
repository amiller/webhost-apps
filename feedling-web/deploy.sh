#!/bin/bash
# Deploy feedling-web to PROD (pod.dstack.soc1024.com) via tarball upload (no GitHub).
# Usage: ./deploy.sh check   # what sha is prod serving vs staging?
#        ./deploy.sh         # deploy current HEAD, preserving the deployed env
set -euo pipefail

# The hermes-staging CVM this used to name has not served the app for weeks — the live instance
# is `tee-isolated-feedling-web-dev` on oauth3-prod7, reached via the custom domain.
CVM="https://pod.dstack.soc1024.com"
PROJECT_NAME="feedling-web"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Extract only the token — sourcing the whole prod-secrets file aborts under set -e (it has a
# malformed line that runs as a command).
DAEMON_TOKEN="${DAEMON_TOKEN:-$(grep -m1 '^TEE_DAEMON_TOKEN=' "$HOME/.oauth3-prod-secrets.env" | cut -d= -f2-)}"
[ -n "$DAEMON_TOKEN" ] || { echo "no TEE_DAEMON_TOKEN in ~/.oauth3-prod-secrets.env — abort"; exit 1; }

# The tarball is the WORKING TREE, not the commit. Stamping a bare sha while the tree is dirty
# claims prod runs code that commit contains — and it does not. Say so instead.
SHA=$(git -C "$HERE" rev-parse --short HEAD)
[ -z "$(git -C "$HERE" status --porcelain -- "$HERE")" ] || SHA="$SHA-dirty"
# Owner token: the deployed manifest is the live copy, ~/.oauth3-prod-secrets.env the durable one.
# Passing FEEDLING_ADMIN_TOKEN explicitly still wins, which is how you rotate it.
: "${FEEDLING_ADMIN_TOKEN:=$(grep -m1 '^FEEDLING_ADMIN_TOKEN=' "$HOME/.oauth3-prod-secrets.env" 2>/dev/null | cut -d= -f2-)}"

if [ "${1:-}" = check ]; then
  # A 404 here is a real answer, not a failure: it means prod predates /api/version, i.e. it is
  # older than this commit by definition.
  V=$(curl -s -m20 -w '\n%{http_code}' "$CVM/$PROJECT_NAME/api/version")
  case "$(printf '%s' "$V" | tail -1)" in
    200) PRODSHA=$(printf '%s' "$V" | head -1 | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha") or "(deployed without GIT_SHA)")');;
    404) PRODSHA="(no /api/version — prod predates the sha stamp, so it is older than HEAD)";;
    *)   PRODSHA="(unreachable: HTTP $(printf '%s' "$V" | tail -1))";;
  esac
  git -C "$HERE" fetch -q origin staging 2>/dev/null || true
  echo "prod     $PRODSHA"
  echo "staging  $(git -C "$HERE" rev-parse --short origin/staging)"
  echo "HEAD     $SHA"
  exit 0
fi

# env comes from the DEPLOYED MANIFEST, not a local .env. That file is gone from this box, and
# re-deriving it would mint FRESH VAPID keys — which silently kills every existing push
# subscription, since a subscription is bound to the applicationServerKey it was created with.
CURRENT=$(curl -sf -m20 "$CVM/_api/projects/$PROJECT_NAME" -H "Authorization: Bearer $DAEMON_TOKEN") \
  || { echo "cannot read the deployed manifest — abort (nothing was changed)"; exit 1; }

TARBALL="$(mktemp --suffix=.tar.gz)"
trap 'rm -f "$TARBALL"' EXIT
tar -czf "$TARBALL" -C "$HERE" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./.env' \
  --exclude='./subs.json' \
  .
echo "tarball: $(du -h "$TARBALL" | cut -f1)"

MANIFEST="$(mktemp --suffix=.json)"
trap 'rm -f "$TARBALL" "$MANIFEST"' EXIT

# There is deliberately no --force/DELETE path any more: deleting the project drops the manifest,
# and with it the only surviving copy of VAPID_PRIVATE_KEY and OPENROUTER_API_KEY.
printf '%s' "$CURRENT" | SHA="$SHA" NAME="$PROJECT_NAME" OUT="$MANIFEST" \
  ADMIN="${FEEDLING_ADMIN_TOKEN:-}" python3 -c '
import json,os,sys
m=json.load(sys.stdin)
for k in ("container_id","deployed_at","image_digest","tree_hash","port"): m.pop(k,None)
env=dict(m.get("env") or {})
env["GIT_SHA"]=os.environ["SHA"]
if os.environ.get("ADMIN"): env["FEEDLING_ADMIN_TOKEN"]=os.environ["ADMIN"]
if not env.get("FEEDLING_ADMIN_TOKEN"):
    sys.exit("no FEEDLING_ADMIN_TOKEN in the deployed manifest and none passed.\n"
             "  Owner routes fail closed without it, so this deploy would lock you out of your own\n"
             "  controls. Generate one and pass it through (save it somewhere):\n"
             "    FEEDLING_ADMIN_TOKEN=$(openssl rand -hex 24) bash deploy.sh")
for k in ("VAPID_PRIVATE_KEY","VAPID_PUBLIC_KEY"):
    if k not in env: sys.exit("manifest lost %s — refusing to deploy, fresh keys would kill the push subs"%k)
m["env"]=env; m["ref"]=os.environ["SHA"]; m["source"]="tarball://"+os.environ["NAME"]
open(os.environ["OUT"],"w").write(json.dumps(m))
print("  manifest: %d env keys preserved, GIT_SHA=%s"%(len(env),env["GIT_SHA"]))'

echo "Deploying $PROJECT_NAME via multipart upload..."
RESPONSE=$(curl -sf -X POST \
  -H "Authorization: Bearer $DAEMON_TOKEN" \
  -F "manifest=@$MANIFEST;type=application/json" \
  -F "files=@$TARBALL;type=application/gzip" \
  "$CVM/_api/projects")
# The daemon echoes the FULL manifest back, env included — printing it raw dumped
# VAPID_PRIVATE_KEY, OPENROUTER_API_KEY and the owner token into the terminal and its scrollback.
printf '%s' "$RESPONSE" | python3 -c 'import json,sys; m=json.load(sys.stdin); print("Deployed: %s ref=%s mode=%s (%d env keys, not shown)"%(m.get("name"),m.get("ref"),m.get("mode"),len(m.get("env") or {})))'

echo "Waiting 25s for runtime to restart..."
sleep 25
echo "version: $(curl -s -m20 "$CVM/$PROJECT_NAME/api/version")"
echo "vapid:   $(curl -s -m20 "$CVM/$PROJECT_NAME/api/vapid-key")"
echo "  ^ must still start BFvQJelJlHbpxnVFhGiNc0hGluqwzJezwcEoE88Nqrdouj — if it changed, the"
echo "    existing push subscriptions are dead and every device needs re-enrolling."
echo "Visit: $CVM/$PROJECT_NAME/"
