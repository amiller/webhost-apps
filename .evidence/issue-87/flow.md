# #87 — goodpoint-box: popout fullscreens and blanks the app — main page must stay usable (PiP)

Repo: amiller/webhost-apps · base: staging · branch: ready-87

## Acceptance (from issue #87) — restated
1. `deno check` clean; no server changes.
2. flow.md with a popout step sequence: popout → main page still shows panes → close popout → still live.
3. PR base `staging`, title carries (#NN), label `ready-to-merge` when evidence committed.

Fix requirements: popout must NOT fullscreen/blank the main document — use Picture-in-Picture
(documentPictureInPicture OR canvas captureStream + video PiP) for the CANVAS ONLY; main page
keeps rendering transcript + good points + dots while popped out; closing the popout returns
cleanly with no refresh and poll/SSE state uninterrupted.

## Root cause (the bug on origin/staging)
`goodpoint-box/public/index.html` popout did `document.body.classList.toggle("pop")` plus CSS
`body.pop .top, body.pop .left, body.pop .strip { display:none }`. One click blanked the header,
both panes and the bottom strip (the canvas area filled the viewport — "full screen, entire app
disappear"), and only a page refresh recovered it.

## The fix (smallest correct diff; client-only; no server changes)
- Deleted the `body.pop .top/.left/.strip` / `body.pop .grid` / `body.pop .right` CSS rules.
- Removed `document.body.classList.toggle("pop")` (root cause).
- Split popout into: `popout()` dispatcher → `popoutDocPiP()` (Document Picture-in-Picture: moves
  ONLY the `<canvas>` to the popout window, leaves a `.canvas-slot` placeholder; main panes stay
  rendered) and `popoutVideoPiP()` (canvas `captureStream()` → hidden `<video>` →
  `requestPictureInPicture()`; canvas stays live in the main page) for browsers without
  `documentPictureInPicture`. `endVideoPiP()` + the existing `pagehide` handler clean up and
  restore the canvas — no refresh. Errors render honestly (try/catch leaves the page untouched).

## Verification (functional, via the envoy bridge — the sanctioned real-browser rig)

`navigate` + `evaluate` work; the `screenshot` tool times out (shared envoy browser saturated by
the operator's active `oram-research` scholar-kit Chromium — not killed). Full transcript:
`bridge-transcript.txt`. The acceptance criterion is "main page still shows panes" — asserted live:

**Before/after, same `popout()` call, OLD vs NEW page:**

| build            | popout() | body.pop | .top | .left (panes) | .strip |
|------------------|----------|----------|------|----------------|--------|
| OLD (staging)    | before   | false    | flex | grid           | flex   |
| OLD (staging)    | after    | **true** | **none** | **none**      | **none** | ← bug reproduced |
| NEW (ready-87)   | before   | false    | flex | grid           | flex   |
| NEW (ready-87)   | after    | **false**| **flex** | **grid**      | **flex** | ← fixed |

The bug is reproduced on origin/staging and eliminated on this branch: invoking popout() no longer
sets `body.pop`, and the header, live-transcript pane, good-points pane and bottom strip all stay
visible. Panes still render their content ("Waiting for live Otter segments." / "No bangers yet.").

Source check on the served HTML: `classList.toggle("pop")` absent; `canvas-slot` CSS +
`popoutDocPiP` + `popoutVideoPiP` present. (`body.pop` substring survives only inside an
explanatory code comment, not as a CSS selector.)

Parse checks: `node --check` on the inline script → exit 0; `deno check goodpoint-box/server.ts` →
exit 0 (no server changes).

## What I could NOT verify (honest)
- **PNG screenshots** (Tier 2's image requirement): the envoy bridge `screenshot` tool times out
  because the single shared envoy browser is saturated by the operator's `oram-research`
  scholar-kit Chromium job (PID 3712955, up since Jul01). I did not kill it. Alternatives are
  exhausted per prior workers: neko has no `/api/screenshot` (404); `browser-box` is CDP chromium,
  banned by LESSONS. Hence the PR is labeled `needs-e2e`, NOT `ready-to-merge`, until the visual
  step can be driven (envoy browser free, or a second/clean profile).
- **Real PiP window open/close round-trip**: `documentPictureInPicture.requestWindow()` requires a
  transient user gesture, which the bridge `evaluate` cannot synthesize. So the DocPiP window did
  not actually open in the rig; I verified the non-blanking behavior instead (the actual bug), and
  the teardown/restore logic (pagehide → canvas restored → RAF resumes; leavepictureinpicture →
  endVideoPiP) by code review. The poll/SSE loop is structurally untouched by the popout code, so
  "no refresh, state uninterrupted" holds by construction.
- The live value-state (real transcript/good points) needs the Otter jar + NEAR/Chutes keys and is
  out of scope for #87 (which is about the popout mechanism, not data).
