# Flow evidence — issue #73 screenshare-pet

**App:** `screenshare-pet/` (sibling of `screenshare-debug`, same three-file shape).
**Deployed:** webhost-staging — https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-pet/ (version pin verified: `GET /screenshare-pet/version` → `85cbbe20dc9e` == the PR commit).
**Branch served for the bridge drive:** local deno mount at `http://172.17.0.1:8931/screenshare-pet/` (the PR branch, exact same tree) for shots 01–06; shot 07 is the **deployed staging URL** itself.
**Verified:** 2026-07-18, in Brave via the envoy bridge (`flock /tmp/envoy-bridge.lock`).

## Acceptance (from issue #73) — what was asserted

### 1. Headless `__pet.feed` produces the spec'd state transitions — ✓ PASS
Driven via `window.__pet.feed({changedPct, class, hot, _t})` with an injected clock (no capture, no
network). The state machine is a pure function of the latest signal + elapsed time:

```
reset({t0:100000})
feed still       _t=100000  → mood "idle"
feed still       _t=109000  → mood "sleepy"     (9s still)
feed still       _t=122000  → mood "nap"        (22s still)
feed local hot(0.2,0.25)    → mood "attentive"  gaze → {x:0.2, y:0.25}  (tracks the hot region)
feed scene 0.95            → mood "startle"
feed (sustained changedPct 0.5 for 4s) → mood "mesmerized"   (high-motion dwell past mesmerMs)
```

### 2. Synthetic source drives the FULL pipeline (detector + state machine), zero network — ✓ PASS
`window.__pet.runSynthetic({log})` draws a synthetic source (a moving rect + a full-screen flip) on
a hidden canvas, runs it through the REAL tile-diff detector, and feeds the pet. Recorded sequence:

```
still#1   = idle    (still/0.0%)
still→sleepy = sleepy (still/0.0%)
still→nap  = nap    (still/0.0%)
local#1   = attentive (local/10.0%)   hot {0.15, 0.17}
local#2   = attentive (local/6.7%)    hot {0.25, 0.17}
local#3   = attentive (local/11.7%)   hot {0.20, 0.17}
scene     = startle (scene/95.0%)     hot {0.50, 0.50}
```
`framePosts === 0`, `netLog.length === 0` — **zero network calls.** Sleepy → attentive → startled,
end to end, through the real detector.

### 3. No frame POSTs with the mirror toggle OFF — ✓ PASS
With the *debug: mirror to sink* checkbox off (the default), `window.__pet.framePosts().length`
stays `0` across the full synthetic run and every headless feed. The only frame network path is
`captureFrame`'s mirror block, gated by `$("mirror").checked`; the loopback target
`POST /dev/echo` itself responds correctly (curl-verified) but is never reached with the toggle off.
The on-page counter `#cPosts` reads `0` with note "(mirror off — should stay 0)".

### 4. OCR/VLM unconfigured → "not configured" when force-triggered — ✓ PASS
```
forceTrigger("vlm") → "VLM not configured"
forceTrigger("ocr") → "OCR not configured"
counters after: {models:0, ocr:0, vlm:0}   (no calls incremented)
```

### 5. Configured VLM → speech bubble at most once per budget window, counter increments — ✓ PASS
With a VLM stub configured (`setVlmStub`):
```
forceTrigger("vlm") #1 → "a calm desk"          counters.vlm = 1
forceTrigger("vlm") #2 → "VLM budget: try again in 180s"   counters.vlm = 1  (unchanged — suppressed)
```

## What the screenshots show (canvas pixel-probed at shot time)

For each shot the pet canvas center pixel was read back (Brave `--force-dark-mode` does **not** invert
the canvas backing store — the signature inks appear as-authored):

| shot | mood @ shot | canvas center RGB | decoded screenshot |
|---|---|---|---|
| `01-pet-attentive.png` | attentive · "activity upper left" | `[255,72,176]` #ff48b0 | ~847 pink pet pixels |
| `02-pet-startled.png` | startle · "scene change!" | `[255,72,176]` #ff48b0 | ~1078 pink pixels (+ "!" spike) |
| `03-pet-mesmerized.png` | mesmerized · "lots of motion (50%)" | `[181,211,61]` #b5d33d | ~624 green pixels |
| `05-pet-sleepy.png` | sleepy · "still 9s" | `[95,211,217]` #5fd3d9 | ~623 cyan pixels |
| `04-page-overview.png` | idle · counters visible | — | `#cPosts`=0, "(mirror off — should stay 0)" |
| `06-pip-fallback.png` | PiP unsupported here | — | honest fallback note, pet stays in-page |
| `07-deployed-staging.png` | deployed page · sleepy→attentive→startle re-checked live | — | the **deployed staging URL** (`/_api` version pinned to commit `85cbbe20dc9e`), same acceptance green on the live page |

## What I could NOT verify (honest — needs a human / a real desktop)

These are the manual acceptance items that require a real user gesture or a screen-share permission
dialog the headless bridge cannot drive:

- **Real `getDisplayMedia` capture** — the screen-share permission picker is a browser-chrome dialog
  requiring a genuine user gesture; `__pet.feed` / `runSynthetic` exercise the exact downstream
  pipeline (detector + state machine) but not the live capture entry. The capture code is ported
  verbatim from `screenshare-debug` (serving, verified there).
- **The real Document Picture-in-Picture window** — `documentPictureInPicture.requestWindow()`
  needs a user gesture AND Chrome 116+; the bridge browser reports the API absent, so the **in-page
  fallback path is what was exercised** (honest degradation, screenshot 06). On a real Chrome 116+
  desktop the pet would move into the always-on-top window.
- **Live typing → pet-watches flow** — needs the real capture above.
- **Real tesseract.js OCR configured path** — would fetch the model from a CDN at runtime; the
  budget/counter logic and keyword→comment table are verified via the stub; the lazy-load +
  "not configured" path is verified for real.

The headless acceptance (items 1–5) is fully green; the four bullets above are the human/real-desktop
portion of the issue's own "Manual" acceptance line and are flagged for operator walk-through.
