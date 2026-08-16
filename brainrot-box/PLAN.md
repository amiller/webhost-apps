# PLAN — issue #126 (brainrot-box: per-call timeout in streamComplete)

Base: `staging`. Tier: **1** (backend/API behavior change, no direct UI surface).

## Acceptance (from issue #126)
- [ ] Every `streamComplete` call site passes a composed deadline signal; a hung provider aborts in ≤T and the lane's next turn proceeds.
- [ ] Timeout surfaces as an activity/status event naming the lane (e.g. `toolsmith timeout after 60s`).
- [ ] `/diag` gains per-lane `last_turn_at` timestamps (toolsmith, compositor, otter, decoder).
- [ ] Offline test: stub `StreamProvider` that never resolves → turn aborts at the deadline, loop continues, status event pushed.
- [ ] Existing tests stay green (16; issue says "13" — predates #124's 3 trace tests).

## Implementation (brainrot-box/server.ts)
1. Cfg: add per-call timeout fields (defaults toolsmith 60s, compositor/distill/decoder/judge 30s; env `*_TIMEOUT_MS`).
2. `streamComplete(..., signal, timeoutMs=0)`: compose `AbortSignal.any([signal, deadline])` via a manual `AbortController`+`setTimeout` (cleared in `finally`, `Deno.unrefTimer` so it never pins a quiet process); on deadline throw `timeout after <T>s`.
3. Call sites pass their `*_TimeoutMs`: toolsmithTurn, compositorTurn, distill, decoderTurn, judgeRecent.
4. Lane-named status: weave loop prefixes `who`; distill/judge self-catch → `status "distill/judge ..."`, decoder self-catch → `activity who:decoder`.
5. `lastToolsmithTurnAt`/`lastCompositorTurnAt` fields (otter=`lastFetchAt`, decoder=`lastDecodeAt` already exist); `/diag.lanes` block.
6. README "Honest edges" amended (was stale: "no per-call timeout") + `Spec impact — #126` entry (CONSTITUTION step 6).
7. tests/server_test.ts: 3 new tests (weave-loop hung provider; judge self-catch; /diag lanes).

## Evidence (Tier 1)
- `deno check` + `deno test` green (incl. new hung-provider test = definitive proof a stalled stream aborts at the deadline).
- Local HTTP `/diag` transcript showing the new `lanes` block, commit pinned.
- Staging deploy deferred to operator (needs `NEAR_API_KEY`/`CHUTES_API_KEY` per flow.md) — the timeout logic is provable without live keys; noted honestly.
