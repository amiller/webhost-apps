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
- `/tools/library` durable archived tools (content-addressed by draw-body hash) · `/archive/flush` gzip+ship local traces to the external store · `/archive/traces` (+`/<id>`) durable trace listing + gunzipped NDJSON
- `/traces` list session traces · `/traces/<id>` stream a session's events back as NDJSON
- `/diag` lane + registry + otter status + trace write state + **archive** block · `/reset` fresh session (reseeds starters, archives+rotates the trace)

## Honest edges

- Session **event traces persist to disk** (#124): every pushed event appends one JSON line to
  `traces/<session-start-iso>.jsonl` under the cwd, rotated on boot and `/reset`, listed by
  `/traces` and streamed by `/traces/<id>`. fs errors surface as a `status` event + `/diag`
  `trace.write_ok=false` (no in-memory fallback). Other state (transcript/ledger/composition) is
  still in-memory. Traces survive a process restart within the same deployed tree and accumulate
  across `/reset`; a **redeploy** wipes them (the daemon re-extracts the tarball, which does not
  carry `traces/`) — verified on staging 2026-07-24.
- **Durable external archive + tool library** (#130): an `ARCHIVE_DIR`-backed store (reference
  `local` backend; `ARCHIVE_BACKEND` selects the implementation, never baked in) holds gzipped
  session traces and a content-addressed tool library (`tools/<sha256(draw)>.json`, deduped by
  draw body). The toolsmith archives every generated tool on generation **and** eviction; a
  `SEED_FROM_LIBRARY=true` boot reseeds a fresh registry from the library so a good tool from one
  session returns in the next. `flushArchive()` (supervisor cadence + `/reset` + `POST
  /archive/flush`) gzips local traces to the store then prunes the rotating buffer to `TRACE_KEEP`
  (the open session is never pruned); failures surface as one `status` event + `/diag`
  `archive.last_err` (no fallback). Snapshots flush through the same blob sink once #125 lands.
- Froze a couple of times during the 7/24 all-day run — `streamComplete` has no per-call
  timeout, so a hung stream can wedge a lane.
- STT is TLS to the enclave (not app-layer e2ee); enclave keys are TOFU.
- Toolsmith-built tools can render faint on large canvases (prompt suggests absolute-pixel
  blur; the starters scale by canvas size, generated tools may not).
- The judge's taste is one model's opinion; the ledger keeps the receipts.

## Spec impact — #124 (2026-07-24)

This README previously stated, under Honest edges, *"All state is in-memory … No trace or
snapshot persistence yet."* That line permitted (and described) total event ephemerality — only
the last 500 pushed events lived in memory, and a restart lost the session (the gap #124 was
filed to close). #124 makes the typed **event stream** durable: every pushed event appends to a
per-session JSONL under the cwd (`/traces`, `/traces/<id>`, `/diag … trace.write_ok`), rotated on
boot and `/reset`, with fs errors surfaced (never swallowed, never faked in memory). The old line
is corrected above. Full **snapshot** persistence (transcript / ledger / composition) remains
out of scope and still resets on redeploy; only the event stream is now durable within a deployed
instance. Staging discovery confirmed the dev-mode cwd is writable (`write_ok=true`).
