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

## Prompt craft + continuous brief distillation (#93)

The port had compressed interleave's scaffolding. #93 restores both halves, faithful to the
reference (`~/goodpoint-source/server.pod.ts`):

- **TOOLSMITH_SYSTEM** — restored verbatim from the reference (the thin 4-line version is gone). It
  now carries the full tool contract: the `(ctx,p,t,w,h,txt)` signature, 2-5 numeric params, the
  `ctx.globalAlpha` blendability rule, and the **BUILD A VARIETY** directive rotating through four
  kinds — ATMOSPHERE, 3D/SCENES (with the `sx=w/2+x*f/(f+z)` projection math inline), VECTOR/SVG via
  `Path2D`, and animated TEXT rendering `txt` — plus the compactness rule (~40 lines, no per-pixel
  loops). Diff-verified identical to the reference modulo the `txt` param in the JSON example
  signature (the issue's only permitted adaptation).
- **COMPOSITOR_SYSTEM** — restored to the reference's intentional, brief-led VJ prompt (tone picks
  palette/energy, direction picks motion; evolve but the brief leads).
- **Continuous transcript→visual-brief distillation** — `distillBrief()` distills recent speech into
  `{mood,emphasis,tone,direction}` on the cheap compositor model (~220 tok). The otter lane fires it
  when fresh segments arrive; it self-throttles by `DISTILL_INTERVAL_MS` (default 20s) over a
  `DISTILL_WINDOW_MS` (default 60s) lookback. A banger is still the **priority path**: `judgeRecent`
  stamps `lastBangerAt`, and `distillBrief` yields to a fresh banger for one interval instead of
  overwriting it. So the compositor now steers by a LIVE brief between bangers instead of a static
  one going stale. (Drops in cleanly alongside #90's lanes; `distillBrief` is guarded by a
  `distilling` flag so it can't overlap itself.)
- `GET /diag` now also returns the live `brief` + a `distill` block (`last_distill_at`,
  `last_banger_at`, `distilling`, thresholds). `POST /reset` clears the distill/banger stamps too.

**Note for #94 (follow-up, same brief code):** the distill runs e2ee but its `emphasis` may carry a
near-verbatim phrase; #94 sanitizes the brief so toolsmith/compositor can cleave to a hosted model.

### Verification (#93)
`deno check server.ts` clean; `deno test` 10/10 (3 new #93 tests with a mocked compositor LLM, no
network egress): brief updates from segments with no banger; a banger overrides + holds for one
interval; the cadence throttle skips a too-soon second distill. A mocked-LLM run across three
transcript windows shows the brief evolving (cautious-optimism → heated-debate → relief) and a
banger then overriding + holding (model calls held at 3): `../.evidence/issue-93/run.log`. The live
staging LLM run is operator-gated (no `NEAR/CHUTES` keys on the swarm box) — the issue's acceptance
explicitly permits a mocked LLM, so evidence is offline + the run log here.
