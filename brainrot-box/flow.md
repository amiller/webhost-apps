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

## Conversation-state readouts (#83)

A rolling **recap** ("what were we talking about"), **topic-shift** markers, and an
**audience/purpose/register** estimate, produced by the SAME judge-loop machinery as the good-point
stage (strict-JSON verdicts over a transcript window) — one extra periodic call
(`GoodpointRuntime.stateRecent()`), NOT a new subsystem. 30s throttle; a repeated topic is not
re-pushed.

- Wired into both ingest points: the otter poll loop (`startOtter`) and `ingestSpeech` (mic), each
  after `judgeRecent()`.
- `GET /state` → `{recap, shifts, estimate, last_topic}`; `/diag` reports a `state` block;
  `/reset` clears the state fields.
- UI: a secondary **Conversation state** band under transcript + good points (per the #80 direction);
  empty state = one quiet line, no placeholder rows. Unknown `register` is kept verbatim, not coerced.
- Testability: `GoodpointRuntime` takes an optional `stateOverride` (5th ctor arg, mirrors
  `judgeOverride`) so `stateRecent()` is exercised in `tests/server_test.ts` with no e2ee key.

Evidence: `../.evidence/issue-83/flow.md` (render path proven server-side; Tier-2 PNG pending the
browser rig — see that file's "NOT yet met" section).

Current status (unchanged from #80): blocked for complete Tier 2 verification — the OAuth3 Otter
read returns `challenge_pending` and a live weave needs operator-held `NEAR_API_KEY`/`CHUTES_API_KEY`.
The #90 idle logic is verified offline (unit tests) + via a local HTTP transcript; see
`../.evidence/issue-90/transcript.md`.

## Self-eval / staleness self-regulation (issue #92)

The box keeps a value marker on its own output. On the **compositor weave lane**, after each
`compositorTurn`, `observeComposition()`:

1. **Staleness metric (cheap, no LLM):** `signatureOf()` quantizes the composition to a sorted tool
   set + params rounded to a 0.2 bucket (so small jitter collapses). A rolling window of the last
   `STALE_WINDOW` (10) signatures is kept; `staleness` = how many match the current one.
2. **Self-regulate when stuck** (>= `STALE_THRESHOLD` 8 identical), escalating and cycling:
   (a) perturb the brief mood/direction — banger `emphasis` is preserved; (b) set a transient
   `brief.avoid` so the toolsmith is told to build something UNLIKE the over-used tools; (c) retire
   the most-used **non-starter** tool (starters are protected; the palette floor holds).
3. **Optional critic** (`CRITIC_MODEL` / `ENABLE_CRITIC` env, or an injected override): every
   `CRITIC_EVERY` (10) compositions the compositor-class model is asked whether the last 5 are
   visually distinct; its one-line verdict is folded into the brief. Default off.
4. **Surface:** `/diag` gains `self_eval { staleness, stale_window, stale_threshold,
   composition_count, nudge_count, last_nudge_at, last_nudge_action }` and `e2ee.critic_model` /
   `e2ee.critic_enabled`; each nudge pushes an `activity { who: "self-eval", state: "self-nudge: …" }`
   event rendered in the `#selfState` strip span. `/reset` clears the self-eval state.

Integration with the re-architecture (the three design calls): staleness rides the compositor lane,
so it **idles with the weave (#90)** — no new timer, same pattern as #83/#88. `retireMostUsedTool`
respects the **starter-protected LRU (#130)**. `brief.avoid` survives a `distill()`/`judgeRecent()`
brief rewrite until the toolsmith consumes it (one-shot). Offline unit tests prove near-identical
runs nudge and varied runs do not; see `../.evidence/issue-92/`.

## Continuous transcript→visual-brief distillation (issue #93)

The port had compressed interleave's scaffolding; both halves are restored (prompts landed via
#104, the distill stage via #112, output sanitization via #94):

- **`TOOLSMITH_SYSTEM`** carries interleave's full craft: the BUILD A VARIETY directive with the
  four rotating categories (atmosphere / 3D-projection with the inline `sx = w/2 + x*f/(f+z)`
  math / SVG-Path2D emblems / animated typography), blendability, and the compactness rules,
  adapted only for the `txt` caption param, plus the later CRAFT luminosity rules (#94 era).
- **`distill()`** runs whenever new segments arrive (otter poll or mic `/listen` ingest) and the
  12s gate has cleared — matching interleave's reference interval — feeding `recentText(45s)` to
  the distill lane. The distilled brief is sanitized (`sanitizeDistilled`, #94) before the paint
  crew sees it. A judged good point (banger) still **overrides** the brief (the `goodpoint` event
  carries the sanitized banger brief); the next distill evolves it again.

Evidence: `../.evidence/issue-93/` — offline unit test (`#93 distill evolves the brief from
segments with no banger, and a banger still overrides`) plus a deployed-staging run
(`staging-run.log`, pinned tree `50466b3224a3…`) feeding espeak-ng speech through the real STT /
judge / distill LLMs: six windows, six distinct evolving briefs, with real score-8 bangers in the
ledger across the same run. The instance's otter lane polls the real `OAUTH3_CORE` from
`.intake-env`; its `OTTER_TOKEN` is currently dead (`token delegation invalid`) — the mic ingest
path is unaffected.
