#!/usr/bin/env bash
# #93 evidence — deployed-staging run: briefs changing across a transcript window.
# Feeds espeak-ng-synthesized speech (tts.py — synthetic, no personal data) to the DEPLOYED
# brainrot-box on staging via POST /listen. The deployed instance runs its REAL STT + judge +
# distill LLMs (no mocks). Each POST ingests a segment; the ~16s spacing between POSTs lets the
# 12s distill gate and 15s judge gate clear, so every window distills a fresh brief.
# The otter lane of the deployed instance polls the real OAUTH3_CORE from .intake-env; its
# dead OTTER_TOKEN errors surface honestly in the status events below.
set -euo pipefail
cd "$(dirname "$0")"
source "$HOME/.tee-daemon-staging.env"
source "$HOME/paseo-batch/.intake-env"
APP="${TEE_DAEMON_URL:?}/brainrot-box"
LOG="staging-run.log"
: > "$LOG"
say() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

say "# brainrot-box #93 — briefs changing across a transcript window (deployed staging, REAL LLMs)"
say "# core: OAUTH3_CORE=$OAUTH3_CORE (from ~/paseo-batch/.intake-env) — the env the instance was deployed with"
say "# deploy pin (daemon /_api/projects):"
curl -fsS "$TEE_DAEMON_URL/_api/projects" -H "Authorization: Bearer $TEE_DAEMON_TOKEN" |
  python3 -c 'import json,sys
for p in json.load(sys.stdin):
    if p.get("name") == "brainrot-box":
        print("brainrot-box tree_hash", p.get("tree_hash"), "deployed_at", p.get("deployed_at"))' | tee -a "$LOG"
say "# app /diag before:"
curl -fsS "$APP/diag" | python3 -m json.tool | tee -a "$LOG"

SEQ="$(curl -fsS "$APP/events" | python3 -c 'import json,sys; print(json.load(sys.stdin)["seq"])')"
say "# events cursor before run: seq=$SEQ"

# W1: calm demo-prep talk -> expect a measured/curious brief
# W2: heated budget argument -> expect a tense/fast brief
# W3: a decision lands -> expect a settled brief; the last line is engineered as a good point
for w in w1a w1b w2a w2b w3a w3b; do
  say ""
  say "=== POST /listen $w.wav (speech -> real STT -> judge + distill on the instance) ==="
  RESP="$(curl -fsS -m 180 -X POST "$APP/listen" --data-binary @"$w.wav" || echo "POST FAILED")"
  echo "$RESP" | tee -a "$LOG"
  say "--- /events since $SEQ ---"
  EVENTS="$(curl -fsS "$APP/events?since=$SEQ")"
  echo "$EVENTS" | python3 -c 'import json,sys
d = json.load(sys.stdin)
for e in d["events"]:
    t = e.get("type")
    if t == "brief":
        print("  BRIEF ", json.dumps(e["brief"], sort_keys=True))
    elif t == "segment":
        print("  SEG   ", json.dumps(e["segment"], sort_keys=True))
    elif t == "goodpoint":
        print("  POINT ", json.dumps({"quote": e["point"]["quote"], "score": e["point"]["score"]}, sort_keys=True), "| brief:", json.dumps(e.get("brief", {}), sort_keys=True))
    elif t == "status":
        print("  STATUS", e.get("text", ""))' | tee -a "$LOG"
  SEQ="$(echo "$EVENTS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["seq"])')"
  [ "$w" = "w3b" ] || sleep 16
done

say ""
say "# brief events above show the distilled brief EVOLVING across the three windows."
say "# app /diag after:"
curl -fsS "$APP/diag" | python3 -m json.tool | tee -a "$LOG"
