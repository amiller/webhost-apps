#!/usr/bin/env bash
# Objective definition of done for login-with-everything. Exits 0 (PASS) only when the
# app is actually deployed to staging and the legibility artifacts exist. The worker
# must make THIS pass — not its own opinion of "done". Copy into the project dir.
set -uo pipefail
cd "$(dirname "$0")"
[ -f ../.staging-env ] && source ../.staging-env
BASE="${WEBHOST_STAGING:?WEBHOST_STAGING not set (../.staging-env)}"
URL="$BASE/login-with-everything/"
fail(){ echo "FAIL: $1"; exit 1; }

code=$(curl -s -o /tmp/lwe.html -w '%{http_code}' --max-time 25 "$URL") || fail "app unreachable"
[ "$code" = 200 ] || fail "app not deployed (http $code) at $URL — DEPLOY it, don't just document it"
grep -qi "login with everything" /tmp/lwe.html || fail "app content missing at $URL"
grep -q "window.oauth3" /tmp/lwe.html || fail "connect flow (window.oauth3.connect) missing"
grep -q "/api/plugins" /tmp/lwe.html || fail "dynamic provider list (/api/plugins fetch) missing"
[ -f REPORT.md ] || fail "no REPORT.md (see DEFINITION_OF_DONE.md)"
grep -q "login-with-everything" REPORT.md || fail "REPORT.md must contain the live deployed URL"

# Render the LIVE app and assert the screenshot actually shows the app — non-blank AND
# the visible page text contains "login with everything" with no error markers. This
# replaces the old `ls screenshots/*.png` existence theater (a file existing != a journey).
CHROME=$(ls "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)
[ -n "$CHROME" ] || fail "no chrome to render/verify the app screenshot"
mkdir -p screenshots
"$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars --window-size=680,900 \
  --virtual-time-budget=7000 --screenshot=screenshots/acceptance-live.png "$URL" >/dev/null 2>&1
bash ../harness/assert-content.sh --shot screenshots/acceptance-live.png \
  --html-file /tmp/lwe.html --expect "login with everything" || fail "live screenshot/content assertion failed"
echo "PASS: live at $URL, rendered screenshot content-verified (still needs human extension-e2e before merge)"
