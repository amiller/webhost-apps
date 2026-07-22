# Issue #66 — share-kit `oauth3Connect()` + timeline-peek adoption (Tier 2)

## Acceptance (from the issue)
1. share-kit exposes an inlinable `oauth3Connect({plugin, app, node, onStatus})` that runs the
   connect handshake; on a step-up `challenge_pending` shows "waiting for your approval" and
   **polls (capped, ~20×4s) until approved**, then proceeds; on a terminal error renders the
   **real** error (no raw dead-end, no mock/mask). Mirrors otterpilot's proven poll pattern.
2. timeline-peek adopts it: clicking Connect no longer shows a raw `challenge_pending`
   dead-end — it shows "waiting for approval…" on a step-up, or an honest readable error when
   the twitter backend is down.

## What was walked (signed-in, deployed staging, real Brave + oauth3 extension via the envoy bridge)

Staging URL: `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/timeline-peek/`
Bridge: real Brave **with the oauth3 extension loaded** (`window.oauth3` present), driven through
`POST http://localhost:3000/api/bridge` under `flock /tmp/envoy-bridge.lock`.

1. **`01-landing.png`** — navigated to staging `/timeline-peek/`. Asserted via `evaluate` at
   capture: `location.href` = the staging timeline-peek URL, `document.title` = "Home / Timeline
   Peek", `typeof window.oauth3` = `"object"` (extension present), `typeof window.ShareKit` =
   `"object"` (inlined share-kit v0.2.0 loaded), `#go` (Connect button) present.
2. **`02-approval-dialog.png`** — clicked `#go` (Connect). The extension's consent dialog
   (`#oauth3-approve`, shadow-DOM) appeared — asserted via `evaluate`:
   `document.getElementById('oauth3-approve').shadowRoot.querySelector('.go')` exists — then
   screenshotted. This is the extension-mediated user-gesture step.
3. Approved in the dialog (clicked `.go`). The wallet carried the connect handshake end-to-end
   and returned a scoped token (the read below only runs once a token exists).
4. **`03-settled.png`** — the gated read (`ShareKit.oauth3Read(NODE, "/api/twitter/feed", token)`)
   ran as the probe. On staging the twitter read returns **409 `{"error":"no jar synced for
   twitter"}`** (the bridge browser holds no x.com session), which `oauth3Read` classifies as
   **terminal** (it is not a `challenge_pending` 409), so `oauth3Connect` re-threw it and
   timeline-peek rendered it via `humanizeError`. Asserted via `evaluate` at capture:
   `#note` className = `"note err"`, textContent = **"Couldn't connect: no jar synced for twitter"**.

`final-note.txt` holds the exact rendered note text.

## Assertion vs. the acceptance
- ✅ **No raw dead-end.** The note is the readable sentence `Couldn't connect: no jar synced for
  twitter`, framed by `humanizeError` — NOT the bare node error string and NOT `challenge_pending`.
  (Old code rendered `String(e.message||e)` → raw pink `no jar synced for twitter` / `challenge_pending`.)
- ✅ **Honest terminal error.** The real node error rides through (`humanizeError` preserves the
  underlying message; nothing masked, no fallback, no mock). The actual staging failure mode here is
  "no jar synced for twitter" (the wallet has no x.com session), which is the truthful current state
  — the same graceful path the issue calls out for the browser-SPI-down case.
- ✅ **Connect handshake proven live**, end-to-end through the real extension (dialog → token →
  probe), on deployed staging.
- ⚠️ **"waiting for approval" (step-up) NOT driven live.** The staging node did not emit a runtime
  step-up (`409 challenge_pending` + `challengeId`) on this read — it returned "no jar synced"
  (terminal) — and the runtime step-up endpoint (`GET /api/challenge/:id`) is not yet shipped on
  staging, so a live step-up could not be triggered. That code path is **code-verified and mirrors
  otterpilot's proven challenge-recover pattern (webhost-apps #61/#62)**: `oauth3Read` parses the
  `409 challenge_pending + challengeId` into a retryable marker; `oauth3Connect` fires
  `onStatus("waiting-approval")`, polls `GET /api/challenge/:id` (capped ~20×4s), and re-runs the
  probe on `approved`; `denied`/`expired`/`unknown`/`timeout` are terminal. It activates the moment
  the server ships RFC 0005 runtime step-up. (Driving a live step-up is left to the operator / a
  future issue once the node emits it.)

## Note on verification method
The worker model cannot render images, so each screenshot's content was **asserted via `evaluate()`
at the instant of capture** (DOM state pinned: href/title/`window.oauth3`/`ShareKit` for the landing;
`#oauth3-approve` shadowRoot `.go` for the dialog; `#note` className+textContent for the settled
state). The PNGs are the human-reviewable artifact; the `evaluate` transcripts in this file are the
content check.
