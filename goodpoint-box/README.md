# goodpoint-box

The brainrot box (interleave) merged with a good point detector, as one OAuth3 app.

- **paints**: interleave's toolsmith/compositor canvas — a slow model writes animation
  tools, a fast one VJs them live. Both over e2ee confidential inference
  (NEAR ECIES / Chutes ML-KEM-768). The running ancestor: `pod.dstack.soc1024.com/interleave/app`.
- **judges**: speech comes in through the OAuth3 otter live-follow scope
  (`GET /api/otter/live`, scoped revocable read token — no raw mic, no copied cookies).
  A judge scores the last ~60s of transcript: `{quote, why, score 0-10}`. Score ≥ 7 is a
  banger: the canvas flashes the quote, and `/goodpoints` keeps the ledger.

Origin: the 2026-07-15 Demo Day Planning call ("How many bangers there is, right?" — Tina).
The ledger is the value marker for the feedback-loop framing: bangers per meeting is a number.

## Status

Build spec: [webhost-apps#80](https://github.com/amiller/webhost-apps/issues/80) (in the swarm
lane). This directory currently holds the landing page ([#81](https://github.com/amiller/webhost-apps/issues/81)),
deployed ahead of the app at `pod.dstack.soc1024.com/goodpoint-box/`.

## Routes (per #80)

- `/` — this landing
- `/app` — the box UI
- `/goodpoints` — ledger JSON
- `/diag` — e2ee probe + otter poll status

## Honest edges

- The combined app is not live yet; #80 is in flight.
- Inherited from interleave: STT is TLS to the enclave (not app-layer e2ee); enclave keys
  are TOFU, no full quote-chain verification yet.
- The judge's taste is one model's opinion; the ledger keeps the receipts.
