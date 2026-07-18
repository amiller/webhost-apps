# BLOCKED — need from operator: real-browser walkthrough (envoy bridge has no client)

This PR's user-visible surface (the per-frame change-detect table, the overlay bounding boxes,
the classification badges, the keyframe/OCR/VLM result line) is **Tier 2** and ideally walked
in a signed-in real browser via the envoy bridge. That walkthrough could **not** be driven this
iteration because the bridge browser is disconnected.

## Evidence status

- ✅ **Tier 1 (backend, deployed staging)** — `tier1-staging.md`: grant → `POST /sink/frame`
  (`x-scene`) → `POST /sink/heartbeat` (still) → `POST /sink/keyframe` (bytes/width echoed,
  OCR/VLM `"not configured"`) → `POST /sink/want-keyframe` → next frame response carries
  `wantKeyframe:1280` → `/sink/frames` counters. Build pinned `change-detect-1` via `/health`.
- ✅ **Classifier logic (deterministic)** — `classifier-logic.txt`: the shipped `diffFrame` /
  `boxes` / `classify` are extracted verbatim from `index.html` and asserted: static→`still`
  (0 boxes, POST skipped), moving-rect→`local` (≥1 box, area 12 % < 30 %), color-swap→`scene`
  (100 % tiles hot). Run `node classify.test.cjs`.
- ✅ **Configured-positive OCR/VLM wiring** — verified locally (a throwaway OCR shim + VLM stub;
  NOT shipped) returns `ocr.ok:true` / `vlm.ok:true` and increments `modelCalls`, proving the
  hooks are live and not dead code.
- ⏳ **Tier 2 visual walkthrough** — BLOCKED (below).

## The blocker (precise)

The envoy bridge at `http://localhost:3000` reports **no browser client connected**:

```
$ curl -s localhost:3000/health
{"status":"ok","pendingCommands":49,"wsClients":0}
```

`wsClients: 0` means the neko Brave that executes `navigate`/`evaluate`/`screenshot` is not
attached, so every bridge call returns empty/timeout. This persisted for the whole iteration
(no auto-reconnect over ~5 min). It is operator-managed infra; per LESSONS ("No Playwright/CDP
for real-browser flows") I did **not** spin up a CDP browser as a workaround, and I did not
restart operator services.

The app **is deployed to staging** at `$WEBHOST_STAGING/screenshare-debug/` (build
`change-detect-1` confirmed via `/health`), so once the bridge browser is reattached the
walkthrough is: open the staging URL → click **Start synthetic demo** → cycle the synth-mode
select (`moving rect`→`local`+overlay, `static`→`still`+accepted-count frozen, `color swap`→
`scene`) → click **Hi-res keyframe (1280)** / **OCR keyframe** / **VLM caption** (→
`"not configured"`). The headless hook `window.__ssdebug` exposes `setMode/keyframe/ocr/vlm/
counts` for driving it programmatically.

## Ask

Reattach the envoy/neko browser (or confirm it's back: `curl -s localhost:3000/health |
jq .wsClients` should be ≥ 1), then re-run the walkthrough above and drop the screenshots into
`.evidence/issue-71/`. Until then this PR is labeled `needs-e2e` and is **not** `ready-to-merge`
(Tier 2 evidence incomplete for a user-visible change).
