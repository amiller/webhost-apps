# PLAN — issue #73 screenshare-pet

A PiP pet that seems aware of your screen — the fun demo consumer of the screenshare change-signals
family. New app dir `screenshare-pet/`, sibling of `screenshare-debug`, same three-file shape.
**All authorization machinery kept out** (per #73 non-goals); frames never leave the browser by
default. Built against the change-detection detector implemented inline (the #71 PR is open, not on
staging yet; #73 explicitly allows building the detector inline / against stubbed signals).

## Acceptance (from issue #73, binding) → checkboxes

- [ ] **Headless `__pet.feed` state transitions.** `window.__pet.feed({changedPct, regions, class})`
      drives the state machine with NO capture and NO network. A `still → sleepy → nap`,
      `local → attentive` (gaze tracks), `scene → startle` sequence produces the spec'd moods.
- [ ] **Synthetic source drives the full pipeline** (detector + state machine) from sleepy →
      attentive → startled with zero network calls.
- [ ] **Manual capture path:** Start → screen picker → PiP window opens with the pet canvas;
      honesty status line shows what the pet reacts to; recording indicator while capture live;
      `track.onended` stops capture. (Real PiP + getDisplayMedia need a user gesture — mark the
      un-driven steps honestly; verify the in-page fallback + feature-detect path.)
- [ ] **No frame POSTs with mirror toggle OFF** — assert via the in-page network log (0 POSTs).
      Mirror ON → POSTs to a dev-only loopback echo on this app's own server (no consent machinery).
- [ ] **OCR/VLM unconfigured → "not configured"** when force-triggered.
- [ ] **OCR/VLM configured → speech bubble at most once per budget window**, call counter increments;
      second trigger inside the budget is suppressed.

## Build
1. `screenshare-pet/server.ts` — minimal deno static server + `/health` + `/version` (pinned to
   commit) + dev-only `/dev/echo` and `/dev/caption` loopback endpoints (NO consent, NO sink).
2. `screenshare-pet/public/index.html` — capture pipeline (getDisplayMedia → downsample), the
   tile-diff change detector (`changedPct` + `regions`/hot box + `class` still/local/scene), the
   signal→mood state machine (data table at top), the canvas pet (blob + gaze-tracking eyes),
   Document-PiP with feature-detect + in-page fallback, honesty surface, OCR (lazy tesseract.js)
   + VLM (`VLM_URL`) hooks off by default with a call counter, `window.__pet.*` headless harness,
   synthetic source, network log.
3. `screenshare-pet/project.json`, `screenshare-pet/deploy.sh` (mirror screenshare-debug), README.
4. Add the row to `REGISTRY.md` (self-registering evidence gate).

## Verify (Tier 2 — user-visible new app)
- `deno check server.ts`.
- Serve the branch; drive via the zed bridge: assert `__pet.feed` transitions + synthetic source +
  zero-POST network log + OCR/VLM "not configured" + budget/counter (VLM_URL → dev echo).
- Screenshot the rendered pet (in-page fallback) + the honesty panel into `.evidence/issue-73/`.
- Deploy to staging; pin `/_api/version` (Tier-1 transcript alongside).
- Real PiP window + real `getDisplayMedia` + real tesseract: honestly marked "needs user gesture /
  screen-share permission / model download — not exercised in e2e".
