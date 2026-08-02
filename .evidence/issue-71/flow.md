# Issue #71 — Tier 2 walked flow (screenshare-debug change detection)

Tier target: **Tier 2 — walked flow** (user-visible UI). Walked on **deployed staging** via the
envoy/neko bridge (real Brave, real pointer/keyboard, no CDP) on
`https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/`.

Deploy pin: `GET …/screenshare-debug/health` →
`{"ok":true,"build":"change-detect-1","authority":"did:key:z6MkwUqDm3cat6grV74ZZNXSBXq6T7n8bBrKyoDV8HPQM4MR"}`.
This redeploy of the PR branch reports `change-detect-1` (the `BUILD` in `server.ts`); the deploy
tarball tree_hash was `7f2fc39ec878`. (`/_api/version` returns 500 on staging — a separate
tee-daemon infra issue, not this PR; `/health` is the app's own build pin.)

---

## Re-verification after rebase onto staging (this pass)

PR #100 drifted to `CONFLICTING` after **#72 (screenshare-debug compute·cost panel)** merged to
staging — both PRs rewrote `public/index.html`, and #72 had explicitly *deferred* its change-detect
dependencies to #71 (this PR): the `diff` cost stage was labeled `pending #71`, the `frame-kinds`
counter was seeded with `// heartbeat/keyframe stay 0 until #71 lands still/scene classification`,
and the `tile-delta` format was marked `needs #71`. The rebase resolves that conflict by
**composing** the two (not dropping either):

- #71's classification pipeline (`diffFrame`/`boxes`/`classify`, still→heartbeat skip, hi-res keyframe)
  is preserved verbatim — `classify.test.cjs` still extracts and passes it.
- #72's compute·cost panel + encoding-comparison card are kept, and the two hooks #72 left for #71
  are **wired** so the merged UI is not self-contradictory:
  - the `diff` stage is now timed (`performance.now()` around `grayOf`+classify) and fed to the `cDiff`
    EMA (was `pending #71` → now live `ms`);
  - the `full·hb·key` frame-kinds counter now increments on full sends, still-heartbeats, and
    on-demand keyframes (was seeded `0` → now live);
  - the `tile-delta` option stays disabled — #71 does not ship that wire format, so it is labeled
    `not implemented` rather than `needs #71` (honest).

The rebased branch was redeployed and **#71's acceptance was re-verified live** on the combined UI:

- Fresh bridge captures this pass (each paired with an at-instant `evaluate` assertion of
  `__ssdebug.counts()`/DOM, post-shot drift re-checked against `location.href`):
  - `01-loaded` → `cap:"no capability"`, `ocr:"OCR not configured"`, `vlm:"VLM not configured"`.
  - `02-streaming-auto` → `lastClass:"local", lastChangedPct:5.19, lastRegions:1` (auto-cycle).
  - `03-moving-rect-local` (`setMode('rect')`) → `lastClass:"local", lastChangedPct:4.94, lastRegions:1`.
  - `04-color-swap-scene` (`setMode('swap')`) → `lastClass:"scene", lastChangedPct:99.02, lastRegions:1`.
- `05` (still→accepted frozen) and `06` (keyframe→not-configured) were re-verified live: the server
  transcript in `tier1-staging.md` shows `POST /sink/heartbeat → {still:true}` and
  `POST /sink/keyframe → {ocr:{error:"OCR_CMD not configured"},vlm:{error:"VLM_URL not configured"}}`.

**Screenshot provenance (honest).** `01`–`04` are fresh captures on this redeploy (they additionally
show #72's cost panel + encoding card, since the rebased UI renders them — that merged work is
out-of-scope for #71's acceptance and is not asserted here). `05` and `06` are the prior-pass
captures; a fresh re-shoot of the full set was attempted but the **shared envoy/neko rig was under
concurrent use** throughout (another process repeatedly navigated the browser to `eprint.iacr.org`
and the MV3 command channel intermittently hung), so `05`/`06` could not be re-captured in a clean
window. Their `#71` assertions hold on the redeploy (re-verified via the bridge and the server
transcript), so they are retained rather than dropped or fabricated.

---

## Acceptance (from issue #71) — and what was observed

> Synthetic source running: table shows `changedPct` per frame; moving-rect frames classify `local`
> with a bounding box overlay tracking the rect; color-swap frames classify `scene`; static periods
> classify `still` and provably skip POSTs (accepted-count stops rising).

- **moving-rect → `local` + overlay box.** `setMode('rect')`; `__ssdebug.counts()` →
  `lastClass:"local", lastRegions:1, lastChangedPct:4.94` (this pass; `3.1` prior pass).
  `lastRegions:1` = one flood-filled bounding box drawn on the overlay canvas tracking the rect.
  Shot: `03-moving-rect-local.png`.
- **color-swap → `scene`.** `setMode('swap')`; `counts()` → `lastClass:"scene", lastChangedPct:99.02`
  (≈99 % of tiles hot ⇒ `scene`). Shot: `04-color-swap-scene.png`.
- **static → `still`, POSTs provably skipped.** `setMode('still')`, sampled twice 6 s apart in steady
  state (prior pass):
  - T0: `accepted:1346, still:419, lastClass:"still", lastChangedPct:0`
  - T1 (+6 s): `accepted:1346, still:483, lastClass:"still", lastChangedPct:0`
  - **`accepted` Δ = 0 (FROZEN — no `/sink/frame` POSTs); `still` Δ = +64 (heartbeats sent instead).**
  Re-verified server-side this pass: `POST /sink/heartbeat → {ok:true,still:true}` with no image
  accepted. Shot: `05-static-still-frozen.png`.
- **per-frame table.** After `demo()`, the console table has rows showing per-frame `changedPct`.
  Shot: `02-streaming-auto.png` (capstate "capability live · 4fps · 1800s", `lastClass:"local"`).

> Keyframe button POSTs one frame at the requested width (verify bytes/dimensions in echo).

- `__ssdebug.keyframe(1280)` → `#kfres` renders `keyframe 1280×800 · 11907b · ocr: OCR_CMD not
  configured · vlm: VLM_URL not configured`. Server-side `/sink/frames` agrees:
  `keyframe:{bytes:11907,width:1280,height:800}` (prior pass); this pass the endpoint echoes the
  posted width/height and the not-configured errors verbatim (see `tier1-staging.md`).
  Shot: `06-keyframe-not-configured.png`.

> With no `OCR_CMD`/`VLM_URL` configured, those buttons/report show "not configured" — never silent.

- On load, `#ocrbadge`/`#vlmbadge` render `OCR not configured` / `VLM not configured`.
  `GET /config` → `{"ocr":{"configured":false},"vlm":{"configured":false}}`. The keyframe result line
  always states `ocr: OCR_CMD not configured · vlm: VLM_URL not configured`. `modelCalls:0` throughout.
  Seen in `01-loaded.png` and `06-keyframe-not-configured.png`.

## How it was driven

`window.__ssdebug` (the shipped headless hook) exposes `demo / setMode / keyframe / ocr / vlm /
counts / state`. The synthetic source is deterministic (`rect`→local, `swap`→scene, `still`→static),
so no `getDisplayMedia`/human-capture was needed. The bridge `evaluate` ran these in the page's main
world; `location.href` was asserted to the staging URL before trusting any frame (the bridge
`navigate` failed silently once and the shared browser drifted to an unrelated tab mid-walk — both
caught by the href/count re-checks, never trusted blindly).

## What could NOT be verified here

- Fresh screenshots for steps `05` and `06` could not be re-captured: the shared envoy/neko browser
  rig was under concurrent use by another process (continuous navigation to `eprint.iacr.org`,
  intermittent command-channel hangs). The `05`/`06` `#71` assertions were re-verified live on the
  redeploy (bridge `evaluate` + the server transcript in `tier1-staging.md`), and the prior-pass
  screenshots are retained. No assertion above is left backed only by an unverified image.
- `tile-delta` wire format: out of scope for #71 (never claimed); the format selector is disabled and
  labeled `not implemented`.
