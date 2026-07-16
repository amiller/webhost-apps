# goodpoint-box Flow Notes

This file mirrors the issue #80 evidence summary for the app directory, plus the #90 idle behavior.

- Local UI render evidence: `../.evidence/issue-80/01-local-ui.png`.
- Real Otter ingestion attempt: `../.evidence/issue-80/otter-ingest.json`.
- Deployment attempt: `../.evidence/issue-80/deploy-attempt.txt`.

## Idle behavior (#90) — "stop the weave when nobody is watching"

The runtime runs **two independent lanes**, each with its own AbortController + running flag, plus
a watchdog supervisor:

- **weave** — toolsmith + compositor (~1.8s loop). This is the expensive part (~0.7M tokens/hr).
- **otter** — otter poll + judge (~5s loop). Cheap, load-bearing (segments + good-point ledger).

Keepalives (timestamps the supervisor checks every 5s via `tickIdle`):

- `lastConsumerAt` — refreshed on every `GET /events` (a viewer is watching the canvas). The client
  on `/app` polls `/events` every 800ms, so an open tab holds this fresh.
- `lastLiveAt` — refreshed when the otter response reports `live:true` **or** fresh speech segments
  arrived.

Idle rules (defaults, env-tunable):

- No `/events` poller for **`WEAVE_IDLE_MS`** (default **3 min**) → the **weave** lane stops
  (toolsmith + compositor). The otter/judge lane **keeps running** while a meeting is live.
- No live speech for **`OTTER_IDLE_MS`** (default **10 min**) → the **otter** lane stops too.

Resumes (any of these restarts an idled lane):

- `GET /events` → `resumeConsumer()` → refreshes the heartbeat and restarts an idled weave.
- `GET /app` (UI load) or `POST /start` → `start()` → resumes **everything** (weave + otter + supervisor).

Observability:

- `GET /diag` now carries an `idle` block: `enabled`, `weave_running`, `otter_running`, the two
  thresholds, `last_consumer_at`, `last_live_at`, the `last_*_idle_at` timestamps, and the
  human-readable `*_idle_reason` strings.
- `GET /events` now also returns `weave_running` + `otter_running` alongside `running`.
- Each lane stop pushes an `{type:"idle", lane, reason}` event into the SSE stream.

Testability: `GoodpointRuntime` takes an optional `StreamProvider` (mirrors the existing
`judgeOverride` injection) so the loops can be exercised in `tests/server_test.ts` with **no network
egress**; `tickIdle(now)` is the synchronous idle decision, drivable with synthetic time.

Current status (unchanged from #80): blocked for complete Tier 2 verification — the OAuth3 Otter
read returns `challenge_pending` and a live weave needs operator-held `NEAR_API_KEY`/`CHUTES_API_KEY`.
The #90 idle logic is verified offline (unit tests) + via a local HTTP transcript; see
`../.evidence/issue-90/transcript.md`.
