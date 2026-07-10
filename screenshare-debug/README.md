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
implemented on mobile browsers; a screen-picker prompt appears on Start.

## Acceptance (issue #51)

Open the app → Start → pick a window: within a few seconds the console shows frames
streaming (live preview, the echo strip filling, the per-frame table with bytes/luma/
latency and `delivered = yes`), the destination's attestation shown. Hit Revoke: the stream
visibly stops and the next frame POST 401s in the console.

## Deploy

```bash
bash deploy.sh                 # default echo-sink build, no secrets needed
# AISHLEY_URL=https://… AISHLEY_VERIFY=https://… bash deploy.sh   # enable the aishley sink
```

Design: pod design system · constructivist overprint · watermelon-classic inks (teal
`#00838a` / fluoro pink `#ff48b0`) · light default.
