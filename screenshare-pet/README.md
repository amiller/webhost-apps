# screenshare-pet — a Picture-in-Picture pet that seems aware of your screen

A small animated pet floats in an always-on-top window while you work and **reacts to signals
derived from your screen** — cheap pixel math nearly always (`changedPct` + the hot region + a
`still`/`local`/`scene` class), with rare, budgeted escalation to OCR or a visual model. The
whole thesis of the screenshare family as one toy: **rich-feeling awareness without a model in
the loop**.

Sibling of `screenshare-debug`, same three-file shape — but with **all authorization machinery
kept out** (issue #73 non-goals): no oauth3, no consent grant, no sink. **Frames never leave the
browser by default.** The only network the pet does is the operator-enabled *debug: mirror to
sink* toggle, a dev-only loopback echo on this same app's own server (no credential, no storage).

## The four steps

1. **capture** — `getDisplayMedia` → downsample to ~240px (we want signal math, not pixels).
   Ported from `screenshare-debug`.
2. **detect** — the downsampled frame is tiled 10×6; per-tile mean luma is diffed against the
   previous frame → `{ changedPct, hot, class }` where `class` is `still` / `local` (a few tiles,
   e.g. typing) / `scene` (a global flip, e.g. alt-tab). This is the [#71 change-detection
   spec](https://github.com/amiller/webhost-apps/issues/71) shape, inlined here until that PR
   lands and the two share a module.
3. **react** — a small state machine (a data table at the top of `public/index.html`) maps the
   signal stream to a mood:
   - `still` for a while → **sleepy**, then **naps**.
   - `local`, steady (typing) → **attentive**, eyes tracking the active region's position.
   - `scene` change (alt-tab / page nav) → **startled**.
   - sustained high `changedPct` (video / scrolling) → **mesmerized**.
   - idle 5+ min → **wanders off**.
4. **escalate (rare)** — on a scene change, at most every few minutes, the pet may grab one
   hi-res keyframe for OCR (vendored `tesseract.js`, runs locally) or a one-line VLM caption
   (`VLM_URL`) and *comment* via a speech bubble. A counter shows model calls vs frames
   processed — the point is how rarely it fires.

## Honesty surface

The PiP window shows a status line ("still 42s", "activity upper-left", "scene change") and a
recording-style indicator whenever capture is live. Closing the PiP window or stopping the share
stops capture (`track.onended`, same as `screenshare-debug`). The status line, the recording dot,
and the model/frames counter are **baked into the pet canvas**, so the PiP window and the in-page
card can never disagree.

## Headless harness — no capture, no network

The pet logic is fully testable without a screen-share and without a network. The state machine
is a pure function of the latest signal + elapsed time, exposed on `window.__pet`:

```js
window.__pet.feed({ changedPct: 0.04, class: "local", hot: { x: 0.2, y: 0.3, w: 0.1, h: 0.1 } })
window.__pet.mood()                 // → "attentive"   (gaze tracks the hot region)
window.__pet.runSynthetic({log:[]}) // detector + state machine over a fake moving rect
window.__pet.forceTrigger("vlm")    // respects budget; reports "not configured" when off
window.__pet.framePosts()           // []  with the mirror toggle off
```

`runSynthetic` draws a synthetic source (a moving rect + a full-screen flip) on a hidden canvas,
runs it through the real detector, and returns the mood sequence `{ sleepy, nap, attentive,
startled }` — driving the whole pipeline from sleepy → attentive → startled with **zero network
calls**.

## Privacy

Frames are processed client-side and discarded. The detector keeps only the previous frame's
per-tile luma array (60 floats) — never a pixel. OCR and VLM are **off by default**; when on, they
fire at most once per budget window on a single keyframe, and the call counter is on screen.

## Desktop-only

`getDisplayMedia` isn't implemented on mobile browsers. The Document Picture-in-Picture API is
Chrome 116+; where it's unavailable the pet renders in the in-page card with a visible
*PiP unsupported* note — honest degradation, not silence.

## Acceptance (issue #73)

- **Headless** — `__pet.feed` sequences produce the spec'd transitions; `runSynthetic` drives the
  pet sleepy → attentive → startled with no network calls.
- **Manual** — start capture, open PiP, type in an editor (pet watches, gaze tracks), stop typing
  (pet sleeps), alt-tab (pet startles). No frame POSTs with the mirror toggle off (assert via the
  on-page network counter).
- **OCR/VLM** unconfigured → "not configured" when force-triggered; configured → speech bubble at
  most once per budget window, with the call counter incrementing.

Design: pod design system · constructivist overprint · watermelon-classic inks (teal `#00838a` /
fluoro pink `#ff48b0`) · light default — same register as `screenshare-debug`.
