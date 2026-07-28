#!/usr/bin/env bash
# inline share-kit.js into an adopting app's single-file index.html.
#
# The webhost static runtime serves ONLY the entry file of a project at its mount root
# (e.g. /timeline-peek/ → index.html; every other path 404s), so a shared kit can't be
# loaded with <script src="share-kit.js"></script> from a sibling file — it has to live
# INSIDE the app's one index.html. That matches how every static app in this repo is
# already written (single self-contained index.html, no build).
#
# This script inlines the canonical share-kit/share-kit.js into a marked block in the
# app's index.html, so re-running it picks up kit updates without hand-merging:
#
#   ./inline.sh share-kit          # the demo itself
#   ./inline.sh timeline-peek      # first adopter
#
# First run: inserts the block before the first <script> in the page (so the kit is
# defined before the app script that uses it). Later runs: replace the existing block.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/share-kit/share-kit.js"
APP="${1:?usage: $0 <app-dir> (e.g. timeline-peek / calendar-share)}"
APP_DIR="$ROOT/$APP"
# Apps in this repo ship their entry html at one of two layouts: <app>/index.html
# (timeline-peek, reddit-karma, …) or <app>/public/index.html (calendar-share,
# otterpilot). Resolve whichever exists so every adopter can run inline.sh <app>.
HTML=""
for cand in "$APP_DIR/index.html" "$APP_DIR/public/index.html"; do
  [ -f "$cand" ] && { HTML="$cand"; break; }
done
[ -n "$HTML" ] || { echo "no index.html in $APP_DIR (looked at ./index.html and ./public/index.html)" >&2; exit 1; }
[ -f "$SRC" ] || { echo "canonical $SRC not found" >&2; exit 1; }
VERSION="$(grep -m1 -oE 'VERSION = "[^"]+"' "$SRC" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo unknown)"

python3 - "$HTML" "$SRC" "$APP" "$VERSION" <<'PY'
import sys, re
html_path, src_path, app, version = sys.argv[1:5]
kit = open(src_path).read()
# Escape any literal </script sequence so the HTML parser doesn't close the inlined
# <script> block early. Runtime-safe in JS: "<\/script>" evaluates to "</script>";
# in comments it's inert. A function replacement avoids backreference pitfalls.
kit = re.sub(r'</(script)', lambda m: '<\\/' + m.group(1), kit, flags=re.I)
block = (
    "<!-- share-kit:inline — canonical source: share-kit/share-kit.js (v%s).\n"
    "     Re-run: share-kit/inline.sh %s — do not edit the block by hand. -->\n"
    "<script>\n%s\n</script>\n"
    "<!-- /share-kit:inline -->"
) % (version, app, kit)
marker = re.compile(r"<!--\s*share-kit:inline.*?<!--\s*/share-kit:inline\s*-->", re.S)
html = open(html_path).read()
if marker.search(html):
    new, n = marker.subn(lambda m: block, html, count=1)
    open(html_path, "w").write(new)
    print("updated share-kit block in %s (v%s)" % (html_path, version))
else:
    # first insert: just before the first <script> so the kit precedes the app script.
    if "<script" in html:
        new = html.replace("<script", block + "\n\n<script", 1)
    elif "</head>" in html:
        new = html.replace("</head>", block + "\n\n</head>", 1)
    elif "</body>" in html:
        new = html.replace("</body>", block + "\n\n</body>", 1)
    else:
        sys.exit("no <script>/</head>/</body> hook in " + html_path)
    open(html_path, "w").write(new)
    print("inserted share-kit block in %s (v%s)" % (html_path, version))
PY
