#!/usr/bin/env bash
# registry-evidence.sh — turn REGISTRY.md into the evidence-walk work list (issue #41).
#
# Gap this closes: zed's apps-evidence.sh walked a 5-app list HARDCODED in the script, so a new app
# (e.g. reddit-karma) was invisible to the standing screenshot gate until someone edited a host-side
# file. This makes REGISTRY.md the source of truth instead: it parses the `Evidence URL` + `Expected`
# columns and emits one row per app the gate should drive. A new app PR that adds its REGISTRY.md row
# is thereby self-registering into the screenshot gate — zero host-side edits.
#
# This is the webhost-apps half of #41. The second half is operator-run: zed's apps-evidence.sh swaps
# its hardcoded array for this script's output and evaluates the signal grammar below in the browser.
#
#   bash scripts/registry-evidence.sh                         # rows from origin/staging (default)
#   bash scripts/registry-evidence.sh rows                    # explicit subcommand
#   bash scripts/registry-evidence.sh --ref origin/staging    # default ref (merged apps self-register)
#   bash scripts/registry-evidence.sh --ref HEAD              # current HEAD
#   bash scripts/registry-evidence.sh --file REGISTRY.md      # read a local file (local verify)
#   bash scripts/registry-evidence.sh --app reddit-karma      # filter to one app
#
# Output (one app per line, pipe-delimited, ready for apps-evidence.sh's existing loop):
#   <app>|<evidence-url>|<expected-signal>|<caption>|<known-issue>
#
# Only apps with BOTH a non-`—` Evidence URL and a non-`—` Expected signal are emitted (a screenshot
# card needs both). `caption` is the row's Notes (markdown-stripped); `known-issue` is empty — annotate
# per-app caveats in Notes if a card should carry a warning.
#
# Expected-signal grammar (the <expected-signal> field), evaluated in the browser:
#   title "<text>"               PASS iff document.title.trim() === "<text>"
#   <css-selector> "<text>"      PASS iff document.querySelector(<css>)?.textContent.trim() === "<text>"
# Both forms end with a double-quoted expected string; `title` reads document.title, anything else
# before the quote is a CSS selector. Reference evaluator the bridge can run (classic function-IIFE;
# the envoy bridge's `evaluate` runs each arg as a JS expression and rejects arrow-function syntax):
#   (function(signal){
#     var m = signal.match(/^title\s+"(.*)"$/);
#     if (m) return document.title.trim() === m[1];
#     m = signal.match(/^(.+?)\s+"(.*)"$/);
#     if (m) { var el = document.querySelector(m[1]); return !!el && el.textContent.trim() === m[2]; }
#     return false;
#   })(<json-stringified signal>)
#
# Credentials: none — this script only reads REGISTRY.md (from a git ref or a file). The browser drive
# + screenshot happen in apps-evidence.sh, which holds the bridge lock.
set -euo pipefail

REF="origin/staging"
FILE=""
APP_FILTER=""
MODE="rows"

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    rows) MODE="rows"; shift;;
    --ref) REF="${2:?--ref needs a value}"; shift 2;;
    --file) FILE="${2:?--file needs a value}"; shift 2;;
    --app) APP_FILTER="${2:?--app needs a value}"; shift 2;;
    -h|--help) usage 0;;
    *) echo "unknown arg: $1" >&2; usage 1;;
  esac
done

command -v python3 >/dev/null || { echo "registry-evidence: python3 not found" >&2; exit 2; }

# Resolve the REGISTRY.md text: from a file (--file wins) or from a git ref via `git show`.
REGISTRY_TEXT=""
if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || { echo "registry-evidence: file not found: $FILE" >&2; exit 2; }
  REGISTRY_TEXT=$(cat "$FILE")
else
  command -v git >/dev/null || { echo "registry-evidence: git not found (need it for --ref)" >&2; exit 2; }
  # Run from a webhost-apps checkout so the ref resolves; --file callers may be anywhere.
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  ( cd "$ROOT" && git rev-parse --verify "$REF" >/dev/null 2>&1 ) || {
    echo "registry-evidence: git ref '$REF' not found (run from a webhost-apps checkout, or use --file)" >&2; exit 2; }
  REGISTRY_TEXT=$( cd "$ROOT" && git show "${REF}:REGISTRY.md" 2>/dev/null ) || {
    echo "registry-evidence: REGISTRY.md not found at ref '$REF'" >&2; exit 2; }
fi

REG_FILE=$(mktemp)
printf '%s' "$REGISTRY_TEXT" > "$REG_FILE"
trap 'rm -f "$REG_FILE"' EXIT
python3 - "$REG_FILE" "$APP_FILTER" <<'PY'
import sys, re

path = sys.argv[1]
app_filter = sys.argv[2].strip().lower()

# Collect markdown-table rows. A cell may contain a markdown link [t](u); we never need to
# interpret those for the evidence columns (Evidence URL / Expected are bare), so we keep cells raw.
header = None
rows = []
for line in open(path):
    s = line.strip()
    if not s.startswith('|'):
        continue
    cells = [c.strip() for c in s.strip('|').split('|')]
    if header is None:
        header = [c.lower() for c in cells]
        continue
    if all(set(c) <= set(':- ') for c in cells):   # |---|---| separator
        continue
    rows.append(dict(zip(header, cells)))

def col(row, *names):
    for n in names:
        if n in row and row[n] not in ('', None):
            return row[n]
    return ''

DASH = '\u2014'  # em dash used for "not set" cells

out = []
for r in rows:
    app = col(r, 'app')
    if not app:
        continue
    if app_filter and app.lower() != app_filter:
        continue
    url = col(r, 'evidence url', 'evidence-url', 'evidenceurl')
    sig = col(r, 'expected', 'expected signal', 'expected-signal')
    if not url or url == DASH or url == '-':
        continue
    if not sig or sig == DASH or sig == '-':
        continue
    # Normalize a markdown code-span: the cell is authored as `title "x"` for readability;
    # emit the bare grammar string the browser evaluator runs against.
    if len(sig) >= 2 and sig.startswith('`') and sig.endswith('`'):
        sig = sig[1:-1].strip()
    caption = col(r, 'notes')
    # strip markdown bold/code/backticks from the caption; keep it one line; drop any stray pipes
    caption = re.sub(r'\*\*', '', caption)
    caption = caption.replace('`', '')
    caption = caption.replace('|', '/')
    caption = re.sub(r'\s+', ' ', caption).strip()
    issue = ''
    # the pipe row apps-evidence.sh consumes
    out.append('|'.join([app, url, sig, caption, issue]))

print('\n'.join(out))
PY
