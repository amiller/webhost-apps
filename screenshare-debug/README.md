# screenshare-debug

A debug/sample webhost app for streaming **screen-share frames INTO a pod app** under a
scoped, revocable consent grant — the screen-stream analogue of what twitter-debug is to
the twitter path. Sits alongside feedling (youtube) and timeline-peek (twitter feed) in
the case-study app family.

It exists to bridge two things that already existed but didn't connect:
- **screenshare-frames** (`tee-daemon/examples/screenshare-frames`) — the raw capture
  primitive: `getDisplayMedia` → downsample → per-frame luma → JPEG → unauthenticated POST.
- **aishley** — the consumer, where screen frames are encrypted in-browser to the model's
  enclave (Intel TDX / NEAR AI Cloud); the host sees only ciphertext.

Missing was a proper **consent-wired** debug surface: a scoped, revocable grant that
authorizes the outbound stream, with full visibility into what the pod actually received.

## The novel bit (called out in the app copy)

This **inverts the usual OAuth3 model**: instead of delegating *read* access to an existing
session, it delegates a live **outbound stream** (your screen) under scoped, revocable,
attested consent.

## Architecture (issue #51 operator decision, 2026-07-09)

- **A pod app** — deno `server.ts` on the tee-daemon, like otterpilot / feedling.
- **oauth3 = identity + the trust root of a signed consent grant.** The streamer proves who
  they are via `window.oauth3.signIn` (no plugin required — screen-stream has no OAuth3
  plugin, and the decision **rejected** a companion screen-stream ingredient). **oauth3 is
  never in the frame data path.**
- **The consent grant is issued and HMAC-signed by this app** (the OAuth3-authenticated
  relying party), bound to the OAuth3 subject. The browser carries it as a bearer to the
  sink. *Note on the decision's wording:* it says the grant is "signed via oauth3"; doing
  that literally would require the rejected screen-stream ingredient, so the relying party
  signs it and the grant's trust root is the OAuth3 identity. Faithful to the rest of the
  decision (oauth3-for-identity, frames-direct, revoke→401, no core changes); called out
  here so it can be corrected.
- **Frames stream DIRECT** browser → sink. Two sink modes:
  1. **debug echo-sink** (default) — stores the last 60 frames and echoes them back so you
     SEE what the pod received (proof of delivery). This is the verified path.
  2. **aishley's encrypted-to-enclave ingest** — the "real" target. Its enclave verify link
     is shown on the destination card when configured (`AISHLEY_URL` / `AISHLEY_VERIFY`);
     the ingest itself is **not exercised** by this build (no aishley instance wired here).
- **Revoke** = the grant's `jti` is added to a persisted revocation set; the sink honors it,
  so a post-revoke frame POST **401s — visibly, in the console**.

## Consent grant format

`sdc.<base64url(payload)>.<base64url(hmac-sha256)>` where payload is
`{sub, sink, rate, scope, iat, exp, jti}`. Stateless to verify (signature + expiry), plus a
persisted revocation set for immediate revoke. The HMAC key is generated into the app's
`dataDir` on first run.

## Capture controls

interval (s) · width (px) · JPEG quality — all live. Desktop-only: `getDisplayMedia` isn't
implemented on mobile browsers; a screen-picker prompt appears on Start. A **synthetic demo**
source (no capture permission needed) drives the same pipeline headlessly and is what the
classifier is verified against.

## Acceptance (issue #51)

Open the app → Start → pick a window: within a few seconds the console shows frames
streaming (live preview, the echo strip filling, the per-frame table with bytes/luma/
latency and `delivered = yes`), the destination's attestation shown. Hit Revoke: the stream
visibly stops and the next frame POST 401s in the console.

## Change detection (#71)

On top of the frame pipe, cheap pixel math answers "did something change, and where?" per
frame so a visual model is rarely needed but can be invoked on demand.

- **Per-frame change accounting:** the previous downsampled grayscale frame is kept; each
  frame emits `changedPct` (pixels beyond a per-pixel threshold) shown in the console table.
- **Changed-region tiles:** the frame is split into a ~20×12 tile grid; adjacent hot tiles
  are flood-filled into bounding boxes drawn as an overlay on the live preview.
- **Classification:** `still` (no hot tiles — **the POST is skipped**, only a heartbeat is
  sent so sink accounting stays honest) / `local` (few hot tiles, box area < 30%) / `scene`
  (most tiles hot — alt-tab / page nav; the frame is sent flagged `x-scene`).
- **Hi-res keyframe on demand:** `POST /sink/keyframe` re-draws the source at a requested
  width once (the OCR hook — more pixels than the 320px stream). Triggers: a manual button,
  or a server-side pending request (`POST /sink/want-keyframe`) that the next frame/heartbeat
  response carries back as `{wantKeyframe: <width>}` — the dynamically-passed-along resolution.
- **Optional hooks (OFF by default; degrade to an explicit `"not configured"`, never
  silent):** `OCR_CMD` (server-side, run on each keyframe — e.g. the tesseract CLI) and
  `VLM_URL` (POST image → caption, invoked only on demand so its call counter stays near
  zero when tile-diff is doing its job).

### Acceptance (#71)

- Synthetic source: the table shows `changedPct`; moving-rect frames classify `local` with a
  bounding-box overlay tracking the rect; color-swap frames classify `scene`; static periods
  classify `still` and provably skip POSTs (accepted-count stops rising).
- The keyframe button POSTs one frame at the requested width (bytes/dimensions echoed).
- With no `OCR_CMD`/`VLM_URL` set, the OCR/VLM report reads `"not configured"`.

The classifier (`diffFrame`/`boxes`/`classify`) is unit-verified against those three synth
modes — run `node classify.test.cjs` (extracts the shipped functions from `index.html`).

## Deploy

```bash
bash deploy.sh                 # default echo-sink build, no secrets needed
# AISHLEY_URL=https://… AISHLEY_VERIFY=https://… bash deploy.sh   # enable the aishley sink
```

Design: pod design system · constructivist overprint · watermelon-classic inks (teal
`#00838a` / fluoro pink `#ff48b0`) · light default.
