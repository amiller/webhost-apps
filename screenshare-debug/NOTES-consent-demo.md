# Notes for a separate consent/capability demo (excised from screenshare-debug)

screenshare-debug was briefly built around a consent-grant architecture (issue #51). That
direction was excised 2026-07-15 — the app is now purely the screen-stream analogue of
twitter-debug — but the material is worth its own demo later. What existed, all verified
live before removal (grant → frame → revoke → 401 on staging):

## The consent-grant build (last full version: main @ 2245168)

- **Grant format** `sdc.<b64url(payload)>.<b64url(hmac-sha256)>`, payload
  `{sub, sink, rate, scope, iat, exp, jti}`. Stateless to verify (signature + expiry) plus a
  persisted revocation set (`revoked.json`) for immediate revoke; HMAC key generated into the
  app's `dataDir` on first run. Endpoints: `POST /consent/grant`, `GET /consent/verify`,
  `POST /consent/revoke`; the sink verified the bearer on every frame and 401'd post-revoke.
- **The framing idea**: this *inverts* the usual oauth3 model — instead of delegating READ
  access to an existing session, it delegates a live OUTBOUND stream (your screen) under a
  scoped, revocable grant bound to the oauth3 identity.
- **share-kit receipt** — the capability receipt UI (scope sentence, copyable link, revoke
  button, status pill) was inlined from `share-kit/` (re-run `share-kit/inline.sh <app>`).
- **aishley second sink** — the "real" target: frames encrypted in-browser to the model's
  enclave (host sees ciphertext); `AISHLEY_URL`/`AISHLEY_VERIFY` wired the destination card
  but the ingest was never exercised.

## Why the app hand-rolled grants (the real gap)

oauth3-server has **no token introspection** — a third-party sink can't verify a `tok-…`
bearer (verify() is only reachable at node plugin gates). Filed as
[oauth3-server#121](https://github.com/teleport-computer/oauth3-server/issues/121). When it
lands, a consent demo's sink drops all of its own token code and just calls the node.

## Constraints already decided (don't re-litigate)

- **No delegation innovation in apps** — the demo should use the oauth3 module as-is
  (operator, 2026-07-14). The RFC 0011 did:key UCAN spike (app mints its own capabilities,
  vendored ucan.ts) is parked on branch `screenshare-ucan`; rejected for app use.
- The #51 decision also rejected a companion screen-stream *ingredient* in the core.
