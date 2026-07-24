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

- **judge** (hearing lane): scores the last ~60s of transcript; score ≥ 7 = a banger — the canvas
  flashes the quote and `/goodpoints` keeps the ledger.
- **toolsmith** (paint lane, slow): writes one small canvas layer tool per turn into a bounded registry —
  `MAX_TOOLS` (default 24) LRU; 6 hand-built starter tools seed at boot and are eviction-proof.
- **compositor** (paint lane, fast): stacks 2–5 tools per turn against the distilled visual brief.
- **distill** (hearing lane): continuously re-reads the last ~45s into a visual brief (#93).
- **decoder / state / convtype** (hearing lanes): conversation graph, recap/shift/flow readouts,
  conversation-type verdict.
- Both weave lanes idle when nobody polls `/events`; the otter lane idles after 10 quiet minutes.

## Privacy boundary (#94) — who hears the room

**Everything that hears the room is enclave-encrypted; the paint crew sees a sanitized brief.**

The room's words flow through exactly two places: **Otter STT** (TLS to the enclave; see Honest
edges) and the **hearing lanes** — judge, distill, decoder, state, convtype — which all run on e2ee
confidential inference (NEAR ECIES or Chutes ML-KEM-768). These lanes have **no hosted branch at
all**: `route()` in `server.ts` is the one place that decides transport per lane, and for hearing
lanes it only ever returns an e2ee transport, even if every `*_BASE_URL` is set. Their models
(`JUDGE_MODEL`, `DISTILL_MODEL`, `DECODER_MODEL`, `STATE_MODEL`) deliberately do **not** inherit
`TOOLSMITH_MODEL`/`COMPOSITOR_MODEL`, because those may point at hosted models.

Downstream of the hearing lanes, verbatim room text is **never** sent to another model:

- On a banger, the judge's quote and free-text `why` flow **only to the client** (`SSE
  goodpoint.point`) for local canvas rendering; the brief the crew gets is `sanitizeBrief()` — a
  mood label, a tone/energy from the score, a *structural* emphasis descriptor (word-count +
  sentence register), a constant motion direction. No verbatim n-gram of the quote (unit-tested).
- #93's continuous distillation runs on its own **e2ee** lane, and its output passes through
  `sanitizeDistilled()`: `emphasis` is always replaced by the structural descriptor of the key
  phrase; `mood`/`tone`/`direction` are the model's own paraphrase and any field that trips a
  transcript 3-gram check is blanked and announced as a `status` event (an absent field renders
  "—" on the client — honest, never masked).

Because the paint crew never sees the room's words, it is safe to route **toolsmith/compositor**
(and the compositor-class **critic**, which reads only composition signatures) to a **fast hosted
model** (plaintext) when NEAR's e2ee pool browns out. Configure per lane:

```
JUDGE_MODEL=, DISTILL_MODEL=, DECODER_MODEL=, STATE_MODEL=   # hearing lanes — always e2ee
TOOLSMITH_MODEL=, TOOLSMITH_BASE_URL=, TOOLSMITH_API_KEY=    # set all three to go hosted
COMPOSITOR_MODEL=, COMPOSITOR_BASE_URL=, COMPOSITOR_API_KEY= # set all three to go hosted
```

Leave the `*_BASE_URL` vars unset to keep a paint lane on its e2ee default (the deploy default).
`GET /diag` reports the resolved `{lane, model, transport, hears_room}` for all eight lanes without
disclosing keys or URLs.

Any future stage that distills the transcript into a brief must (a) run on an e2ee hearing lane and
(b) emit its brief through `sanitizeBrief`/`sanitizeDistilled` (or an equivalent that carries no
verbatim n-gram) before it reaches toolsmith/compositor.

## Routes

- `/` landing · `/app` the box UI (live / graph / studio tabs)
- `/listen` POST wav → whisper (confidence-gated) → the full pipeline
- `/goodpoints` ledger · `/graph` conversation graph · `/tools` palette snapshot
- `/tools/library` durable archived tools (content-addressed by draw-body hash) · `/archive/flush` gzip+ship local traces to the external store · `/archive/traces` (+`/<id>`) durable trace listing + gunzipped NDJSON
- `/traces` list session traces · `/traces/<id>` stream a session's events back as NDJSON
- POST `/snapshot` image/jpeg → stores a canvas capture under `snapshots/<session>/` (rejects
  non-image / >2MB with 400; per-session 200-file cap evicts oldest with a status event) ·
  `/snapshots` gallery `[{session,file,t,bytes}]` · `/snapshots/<session>/<file>` the jpeg
- `/diag` lane + registry + otter status + trace write state + **archive** block + snapshot state · `/reset` fresh session (reseeds starters, archives+rotates the trace)

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
  `archive.last_err` (no fallback). Routing canvas snapshots through this same sink is future work.
- **Canvas snapshots persist to disk** (#125): the `/app` client POSTs `canvas.toBlob('image/jpeg')`
  on every goodpoint and on a 60s interval while the weave runs, stored to `snapshots/<session>/`
  under the cwd and listed by `/snapshots` (per-session 200-file cap evicts the oldest with a status
  event). Snapshots survive a process restart within the same deployed tree like traces do; a
  **redeploy** wipes them too (the tarball does not carry runtime `snapshots/`).
- Each `streamComplete` call composes the lane signal with a per-call deadline (#126:
  toolsmith 60s; compositor/distill/decoder/judge/state/convtype 30s, env-tunable via
  `*_TIMEOUT_MS` incl. `STATE_TIMEOUT_MS`; the #92 critic shares the compositor deadline), so a
  stalled `nearStream`/`chutesStream` aborts and surfaces a lane-named `status` event
  ("toolsmith timeout after 60s") instead of wedging the lane. `/diag` carries a `lanes`
  block with per-lane `last_turn_at` so a wedged lane is visible remotely. STT keeps its own retry.
  (Fixes the 7/24 Demo Day booth freezes — previously noted here as "froze a couple of times during
  the 7/24 all-day run; a hung stream can wedge a lane". After the rebase onto staging, the
  state/convtype/critic call sites added by #85/#88/#92 carry the same deadlines — the
  "every call site" claim stays true of the merged tree, not just the branch as cut.)
- STT is TLS to the enclave (not app-layer e2ee); enclave keys are TOFU.
- Toolsmith-built tools can render faint on large canvases (prompt suggests absolute-pixel
  blur; the starters scale by canvas size, generated tools may not).
- The judge's taste is one model's opinion; the ledger keeps the receipts.

## Spec impact — #126 (2026-07-24)

This README previously stated, under Honest edges, that *"`streamComplete` has no per-call timeout, so a hung stream can wedge a lane."* That line described the defect behind the 7/24
Demo Day booth freezes: each lane's `AbortController` only fires on stop, so one stalled TCP
stream (`nearStream`/`chutesStream`) froze the lane's while-loop forever and the UI kept polling,
looking frozen. #126 composes every `streamComplete` call site with a per-call deadline
(`AbortSignal.any([signal, deadline])`, implemented as a manual `AbortController` +
`setTimeout`; T generous per call site — toolsmith 60s, compositor/distill/decoder/judge 30s;
env-tunable via `*_TIMEOUT_MS`). A timeout throws a stable error the lane surfaces as a `status`
event naming the lane ("toolsmith timeout after 60s"), then continues to the next turn — no
fallback, no retry. `/diag` gains `lanes.{toolsmith,compositor,otter,decoder}.last_turn_at`
(+ `timeout_ms`) so a lane claiming `running` with a stale `last_turn_at` is the visible
signature of a hang. The old line is corrected above.

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
