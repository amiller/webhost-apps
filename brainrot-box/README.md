# brainrot-box

Live meeting VJ: speech comes in (Otter live-follow or the mic), a judge flags "good points,"
a slow model builds canvas animation tools, a fast model composes them into visuals that
follow the room. Both inference lanes run over e2ee confidential inference
(NEAR ECIES / Chutes ML-KEM-768).

**Live:** `pod.dstack.soc1024.com/brainrot-box/` · lineage: interleave → goodpoint-box (#80) → brainrot-box.

## Baseline

Tag [`brainrot-demo-day-2026-07-24`](https://github.com/amiller/webhost-apps/releases/tag/brainrot-demo-day-2026-07-24)
is the version that ran the Demo Day booth all day (registry held at its 24-tool cap; eviction verified live).

## How it works

- **judge**: scores the last ~60s of transcript; score ≥ 7 = a banger — the canvas flashes the
  quote and `/goodpoints` keeps the ledger.
- **toolsmith** (slow lane): writes one small canvas layer tool per turn into a bounded registry —
  `MAX_TOOLS` (default 24) LRU; 6 hand-built starter tools seed at boot and are eviction-proof.
- **compositor** (fast lane): stacks 2–5 tools per turn against the distilled visual brief.
- **decoder**: types utterances into a conversation graph (topics, decisions, questions).
- Both weave lanes idle when nobody polls `/events`; the otter lane idles after 10 quiet minutes.

## Routes

- `/` landing · `/app` the box UI (live / graph / studio tabs)
- `/listen` POST wav → whisper (confidence-gated) → the full pipeline
- `/goodpoints` ledger · `/graph` conversation graph · `/tools` palette snapshot
- `/diag` lane + registry + otter status · `/reset` fresh session (reseeds starters)

## Honest edges

- All state is in-memory: a redeploy or restart is a fresh box (starters only). No trace or
  snapshot persistence yet.
- Froze a couple of times during the 7/24 all-day run — `streamComplete` has no per-call
  timeout, so a hung stream can wedge a lane.
- STT is TLS to the enclave (not app-layer e2ee); enclave keys are TOFU.
- Toolsmith-built tools can render faint on large canvases (prompt suggests absolute-pixel
  blur; the starters scale by canvas size, generated tools may not).
- The judge's taste is one model's opinion; the ledger keeps the receipts.
