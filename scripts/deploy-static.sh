#!/usr/bin/env bash
# deploy-static.sh — deploy static apps from this repo to their registered pod instance(s).
#
# Gap this closes (issue #39): a merged-to-staging PR used to change nothing a user could see — a
# static app sat at 404 until someone hand-deployed it. "Merged" was not "deployed". This script is
# the static-app half of the post-merge deploy lane: it re-tarballs a static app from a git ref
# (default origin/staging) and POSTs it to the pod instance(s) named in REGISTRY.md's `Instances`
# column, so a merge to staging reaches the pod without a hand deploy.
#
# It is meant to be invoked by the paseo-batch auto-merge lane right after a webhost-apps PR that
# touches a static-app directory lands on staging: the lane computes the changed-app set from the
# PR's files and calls this with those names. It also stands alone for hand deploys.
#
#   bash scripts/deploy-static.sh timeline-peek                 # deploy one app to its instance(s)
#   bash scripts/deploy-static.sh timeline-peek reddit-karma    # deploy several
#   bash scripts/deploy-static.sh --all                         # every static app in REGISTRY.md
#   bash scripts/deploy-static.sh timeline-peek --ref origin/staging   # default ref
#   bash scripts/deploy-static.sh timeline-peek --ref HEAD              # tarball the current HEAD
#
# v1 is STATIC ONLY. Deno apps keep their own per-app deploy.sh (router-dashboard, feedling-web,
# otterscope, calendar-share, otterpilot). A name that isn't a static app is skipped with a warning
# (root-caused, not silently mis-deployed as static).
#
# Credentials: for the `staging` instance this sources ~/.tee-daemon-staging.env for TEE_DAEMON_URL
# + TEE_DAEMON_TOKEN when they aren't already in the env (see ~/paseo-batch/specs/box-inventory.md).
# `prod`/`hermes-staging` have no daemon token on this box by design → reported as operator-run and
# skipped, never faked.
set -euo pipefail

REF="origin/staging"
APPS=()
ALL=""
REGISTRY="$(cd "$(dirname "$0")/.." && pwd)/REGISTRY.md"

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1; shift;;
    --ref) REF="${2:?--ref needs a value}"; shift 2;;
    -h|--help) usage 0;;
    --) shift; while [ $# -gt 0 ]; do APPS+=("$1"); shift; done;;
    -*) echo "unknown flag: $1" >&2; usage 1;;
    *) APPS+=("$1"); shift;;
  esac
done

[ -f "$REGISTRY" ] || { echo "deploy-static: REGISTRY.md not found at $REGISTRY" >&2; exit 2; }
command -v git      >/dev/null || { echo "deploy-static: git not found" >&2; exit 2; }
command -v curl     >/dev/null || { echo "deploy-static: curl not found" >&2; exit 2; }
command -v python3  >/dev/null || { echo "deploy-static: python3 not found" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
git rev-parse --verify "$REF" >/dev/null 2>&1 || { echo "deploy-static: git ref '$REF' not found here (run from a webhost-apps checkout that has it)" >&2; exit 2; }

# --- REGISTRY.md parser (markdown table → column values) ---------------------
#   registry_query static-apps             → print one static app name per line
#   registry_query instances <app>         → print that app's instance aliases, one per line
registry_query() {
  python3 - "$REGISTRY" "$@" <<'PY'
import sys, re
path, mode = sys.argv[1], sys.argv[2]
header, rows = None, []
for line in open(path):
    s = line.strip()
    if not s.startswith('|'):
        continue
    cells = [c.strip() for c in s.strip('|').split('|')]
    if header is None:
        header = cells
        continue
    if all(set(c) <= set(':- ') for c in cells):   # |---|---| separator
        continue
    rows.append(dict(zip(header, cells)))

def col(row, *names):
    for n in names:
        for k, v in row.items():
            if k.lower() == n.lower():
                return v
    return ''

if mode == 'static-apps':
    for r in rows:
        if col(r, 'runtime').lower() == 'static' and col(r, 'app'):
            print(col(r, 'app'))
elif mode == 'instances':
    target = sys.argv[3].lower()
    for r in rows:
        if col(r, 'app').lower() == target:
            inst = col(r, 'instances')
            if inst and inst not in ('—', '-', ''):
                for a in re.split(r'[,/]', inst):
                    a = a.strip()
                    if a:
                        print(a)
            break
PY
}

# Resolve an instance alias from the legend in REGISTRY.md → {URL, token} on this box, or a note.
# Sets globals RESOLVED_URL / RESOLVED_TOKEN / RESOLVED_NOTE.
RESOLVED_URL=""; RESOLVED_TOKEN=""; RESOLVED_NOTE=""
resolve_instance() {
  RESOLVED_URL=""; RESOLVED_TOKEN=""; RESOLVED_NOTE=""
  case "$1" in
    staging)
      if [ -z "${TEE_DAEMON_TOKEN:-}" ] && [ -f "$HOME/.tee-daemon-staging.env" ]; then
        # shellcheck disable=SC1091
        source "$HOME/.tee-daemon-staging.env"
      fi
      RESOLVED_URL="${TEE_DAEMON_URL:-${WEBHOST_STAGING:-}}"
      RESOLVED_TOKEN="${TEE_DAEMON_TOKEN:-}"
      if [ -z "$RESOLVED_URL" ] || [ -z "$RESOLVED_TOKEN" ]; then
        RESOLVED_NOTE="staging daemon URL/token missing on this box (operator-run)"
      fi
      ;;
    prod|pod)
      RESOLVED_NOTE="prod (pod.dstack.soc1024.com) has no daemon token on this box (operator-run)"
      ;;
    hermes-staging)
      RESOLVED_NOTE="hermes-staging has no daemon token on this box (operator-run)"
      ;;
    *)
      RESOLVED_NOTE="unknown instance alias '$1' (see Instances legend in REGISTRY.md)"
      ;;
  esac
}

# deploy_one <app> <instance-alias> <url> <token>  →  tarball from $REF, POST to /_api/projects.
deploy_one() {
  local app="$1" inst="$2" url="$3" token="$4"
  local files
  files=$(git ls-tree -r --name-only "$REF" -- "$app" 2>/dev/null) || true
  if [ -z "$files" ]; then
    echo "deploy-static: $app -> $inst  ✗ not found at $REF"
    return 1
  fi
  if ! printf '%s\n' "$files" | grep -qx "$app/index.html"; then
    echo "deploy-static: $app -> $inst  ⚠ no $app/index.html at $REF — not a static app; skipping"
    return 0
  fi
  if printf '%s\n' "$files" | grep -qxE "$app/(server\.ts|app\.py|index\.js|Dockerfile)"; then
    echo "deploy-static: $app -> $inst  ⚠ has a code entry at $REF (deno/python/node/docker) — use its deploy.sh; skipping"
    return 0
  fi

  local tmp tgz manifest resp tree
  tmp=$(mktemp -d)
  if { git archive --format=tar "$REF" -- "$app" | tar -C "$tmp" -x; } && tar czf "$tmp/app.tgz" -C "$tmp/$app" .; then
    manifest=$(python3 -c 'import json,sys; print(json.dumps({"name":sys.argv[1],"runtime":"static","entry":"index.html"}))' "$app")
    if resp=$(curl -fsS -X POST "$url/_api/projects" \
        -H "Authorization: Bearer $token" \
        -F "manifest=$manifest;type=application/json" \
        -F "files=@$tmp/app.tgz"); then
      tree=$(printf '%s' "$resp" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("tree_hash") or "")[:12])' 2>/dev/null || true)
      echo "deploy-static: $app -> $inst ($url) tree=${tree:-ok}"
    else
      echo "deploy-static: $app -> $inst  ✗ POST to $url failed (curl exit $?)"
      rm -rf "$tmp"
      return 1
    fi
  else
    echo "deploy-static: $app -> $inst  ✗ tarball build failed"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

if [ -n "$ALL" ]; then
  mapfile -t APPS < <(registry_query static-apps || true)
  if [ "${#APPS[@]}" -eq 0 ]; then
    echo "deploy-static: --all found no static apps in REGISTRY.md"
    exit 0
  fi
fi

if [ "${#APPS[@]}" -eq 0 ]; then
  echo "deploy-static: no apps given (pass app names, or --all)" >&2
  usage 1
fi

rc=0
for app in "${APPS[@]}"; do
  insts=()
  mapfile -t insts < <(registry_query instances "$app" || true)
  if [ "${#insts[@]}" -eq 0 ]; then
    echo "deploy-static: $app  ⚠ not listed in REGISTRY.md (or no Instances); skipping"
    continue
  fi
  for inst in "${insts[@]}"; do
    resolve_instance "$inst"
    if [ -n "$RESOLVED_NOTE" ]; then
      echo "deploy-static: $app -> $inst  ⚠ SKIPPED — $RESOLVED_NOTE"
      continue
    fi
    deploy_one "$app" "$inst" "$RESOLVED_URL" "$RESOLVED_TOKEN" || rc=1
  done
done
exit $rc
