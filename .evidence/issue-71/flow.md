# Issue #71 — Tier 2 walked flow (screenshare-debug change detection)

Tier target: **Tier 2 — walked flow** (user-visible UI). Walked on **deployed staging** via the
envoy/neko bridge (real Brave, real pointer/keyboard, no CDP) on
`https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/`.

Deploy pin: `GET …/screenshare-debug/health` → `{"ok":true,"build":"change-detect-1","authority":"did:key:z6Mkv…"}`.
This is the PR branch's code (`const BUILD = "change-detect-1"` in `server.ts`). (`/_api/version`
returns 500 on staging — a separate tee-daemon infra issue, not this PR; `/health` is the app's own
build pin.)

**Note on capture integrity.** Because the reviewer/worker cannot visually eyeball images in this
lane, every screenshot is paired with an `evaluate` assertion of the exact DOM/canvas state captured
at that instant (the `window.__ssdebug.counts()` / `#kbig` / `#kfres` readings below), and each PNG
was `test -s`'d and image-diffed against a login-page reference (all six differ from the login page
by ~463–467/1024 cells and differ from each other appropriately) to rule out blank / wrong-tab frames.

## Acceptance (from issue #71) — and what was observed

> Synthetic source running: table shows `changedPct` per frame; moving-rect frames classify `local`
> with a bounding box overlay tracking the rect; color-swap frames classify `scene`; static periods
> classify `still` and provably skip POSTs (accepted-count stops rising).

- **moving-rect → `local` + overlay box.** `setMode('rect')`; after settle
  `__ssdebug.counts()` → `lastClass:"local", lastRegions:1, lastChangedPct:3.1, scene:33, still:28`.
  `lastRegions:1` = one flood-filled bounding box drawn on the overlay canvas tracking the rect.
  Shot: `03-moving-rect-local.png`.
- **color-swap → `scene`.** `setMode('swap')`; `counts()` → `lastClass:"scene", lastChangedPct:99.0,
  scene:54 (↑ from 33), still:28`. Full-frame color swap each tick ⇒ ~99 % of pixels/tiles hot ⇒
  `scene`. Shot: `04-color-swap-scene.png`.
- **static → `still`, POSTs provably skipped.** `setMode('rect')` (send frames), then `setMode('still')`,
  wait 4 s for the rect→still transition to settle, then sample twice 6 s apart **in steady state**:
  - T0: `accepted:1346, still:419, lastClass:"still", lastChangedPct:0`
  - T1 (+6 s): `accepted:1346, still:483, lastClass:"still", lastChangedPct:0`
  - **`accepted` Δ = 0 (FROZEN — no `/sink/frame` POSTs); `still` Δ = +64 (heartbeats sent instead).**
  Shot: `05-static-still-frozen.png`. (The first 1–2 frames after the mode switch do a full bootstrap
  send, as the spec notes for the init frame; after that, `accepted` is flat while `still` climbs.)
- **per-frame table.** After `demo()`, the console table has rows (`#log.children.length` > 0) showing
  per-frame `changedPct`. Shot: `02-streaming-auto.png` (capstate "capability live · 4fps · 1800s",
  `lastClass:"local"`, 6 table rows).

> Keyframe button POSTs one frame at the requested width (verify bytes/dimensions in echo).

- `__ssdebug.keyframe(1280)` → `#kfres` renders `keyframe 1280×800 · 11907b · ocr: OCR_CMD not
  configured · vlm: VLM_URL not configured`. Server-side `/sink/frames` agrees:
  `keyframe:{bytes:11907,width:1280,height:800}`. Shot: `06-keyframe-not-configured.png`.

> With no `OCR_CMD`/`VLM_URL` configured, those buttons/report show "not configured" — never silent.

- On load, `#ocrbadge`/`#vlmbadge` render `OCR not configured` / `VLM not configured`. `GET /config` →
  `{"ocr":{"configured":false},"vlm":{"configured":false}}`. The keyframe result line always states
  `ocr: OCR_CMD not configured · vlm: VLM_URL not configured`. `modelCalls:0` throughout (no silent
  invocation). Seen in shots `01-loaded.png` and `06-keyframe-not-configured.png`.

## How it was driven

`window.__ssdebug` (the shipped headless hook) exposes `demo / setMode / keyframe / ocr / vlm /
counts`. The synthetic source is deterministic (`rect`→local, `swap`→scene, `still`→static), so no
`getDisplayMedia`/human-capture was needed. The bridge `evaluate` ran these in the page's main world
(verified `typeof window.__ssdebug === 'object'` before each assertion; `location.href` asserted to
the staging URL before trusting any frame).

## What could NOT be verified here

- Nothing for this PR's acceptance. (The earlier blocker — "envoy bridge had no browser client" — is
  resolved: the rig browser is attached. A separate defect was found and fixed along the way: the PR's
  `deploy.sh` shipped a tarball missing `ucan.ts`, which `server.ts` imports — so the runtime router's
  dynamic `import()` failed and the app never served. That is fixed in this branch and the app now
  deploys + serves correctly on staging.)
