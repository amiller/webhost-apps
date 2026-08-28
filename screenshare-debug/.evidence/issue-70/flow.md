# Issue #70 — Tier 2 walked flow (deployed staging)

App: `$WEBHOST_STAGING/screenshare-debug/` · deploy tree `db62714fe671` (2026-08-28T00:11Z)
· `GET /health` → `{"ok":true,"build":"trace-1","mount":"/screenshare-debug",…}` (pinned to this
branch; `/_api/version` 404s on this daemon, so the pin is the health build + daemon tree hash).

Walked in the rig's real Brave via the envoy bridge (:3002, flock-serialized), on the DEPLOYED
staging URL. Session of record: **s-n803vcs0**.

## Acceptance bullet 1 — Start→Stop bounds one trace; nothing has left the browser
- `Start` → 7s of frames → `Stop` (synthetic source, `?synthetic=1` — see "not exercised" below).
- Page showed: session id `s-n803vcs0`, "8 frames · 8 captured", filmstrip with 8 thumbnails,
  freeform note field present. Screenshot **01-record-stop-review.png**.
- Host-side, before any upload: `GET /sink/frames` → **0 entries for s-n803vcs0** ("nothing has
  left the browser yet" — the recorder POSTs nothing until Upload; verified `entries total: 0`).

## Acceptance bullet 2 — delete one frame, draw a blackout rect, Upload; sink verifies
- Deleted the 2nd kept frame (#2); drew rect on frame #1 at 30–72% × 25–70% of the displayed
  frame → page reported `rect 0: 144,75 202×135 (frame px)`.
- Note typed: "staging walk: reproduced the flaky save dialog on settings". `Upload` → 7/7 rows
  delivered. Screenshot **02-after-upload.png**.
- `GET /sink/frames` → kept seqs `[1,3,4,5,6,7,8]` under s-n803vcs0 (deleted #2 ABSENT), note carried.
- `GET /sink/frame/s-n803vcs0/1.jpg` → decoded (jpeg-js), sampled every 2px in the rect interior:
  **4845/4845 px black, worst luma 0.0**; 7266 bright samples outside the rect (not a blank frame).
  Decoded and checked, not eyeballed.

## Acceptance bullet 3 — docker compose run (real capture)
- `docker compose up --build --exit-code-from e2e` → **exit 0**, twice (commits 7a7a12d and after
  the isTrusted fix). Log tail: `PASS — s-nfle92o1: recorded 3 frames, deleted #2, redacted #1,
  uploaded 2; rect black; sink verified.` and `rect interior uniformly black (6205/6205 px, worst
  luma 0.0)`.
- Browser container: headful chromium 151 under Xvfb, capturing its own display via
  `--auto-select-desktop-capture-source="Entire screen"`. `--use-fake-ui-for-media-stream` was
  tried WITH it and BREAKS capture in this chromium (NotReadableError, flag-matrix verified) —
  it is deliberately not passed; auto-select alone resolves the picker. Noted in the PR.
- Screenshots from the compose run: **compose-01-review.png / compose-02-uploaded.png /
  compose-03-devside.png** (taken by the test itself inside the container).

## Flow step 3 — dev side
- Dev side section: session list → `s-n803vcs0` (7 frames, note) → expanded filmstrip (7 imgs,
  deleted #2 absent) + per-frame metadata table (7 rows). Screenshot **03-devside-kept.png**
  also shows the post-`Keep` state: `kept — this trace no longer expires`; server confirms
  `{"kept": true, "expiresAt": null}`.

## What was NOT exercised on the deployed walk
- The real screen-picker step (`getDisplayMedia` on the rig Brave). The bridge drives the page,
  not the browser's native picker chrome, so the deployed walk ran the app's `?synthetic=1`
  frame source (a first-class feature of this build). Real capture — picker auto-resolved,
  real frames — is exercised by the compose e2e above, twice, exit 0.
- The compose run's sink is container-local (ephemeral); its assertions are inside the run log,
  not against the deployed instance.
