# Flow evidence — issue #92 (staleness self-eval), PORTED into brainrot-box for PR #97

Branch: `ready-92` → base `staging`. **This is a port, not a rebase** (operator option 2 from the
prior BLOCKED comment): `goodpoint-box/` was renamed `brainrot-box/` on staging and rewritten
(610→1654 lines); the staleness feature (0 references) was never carried over. This change ports it
into `brainrot-box/server.ts` and adapts it to the re-architected two-lane + idle-shutoff +
starter-protected LRU + distill/brief machinery. The prior PR's `goodpoint-box/*` edits are dropped
(those files no longer exist on base).

## Acceptance (from issue #92 — gate-checked, HAS `## Acceptance`) — and where each is proven

1. **"Offline test: near-identical compositions trigger a self-nudge; a varied run does not."**
   - ✅ `tests.txt` — `deno test` **40/40** (33 baseline + 7 new `#92`). The 7 cover: near-identical→
     nudge, small-jitter-still-stale (quantization), varied→**no** nudge, escalation retires the
     most-used tool (starters protected), banger `emphasis` preserved across a nudge, `/diag` fields,
     and the critic-via-override feeding the brief. The nudge asserts the exact
     `activity{who:"self-eval", state:"self-nudge: …"}` event the UI `#selfState` span renders.

2. **"deno check clean; /diag shows the new fields; flow.md updated."**
   - ✅ `deno check server.ts tests/server_test.ts` → exit 0 (`tests.txt`).
   - ✅ `diag.json` — live local server (this branch) `GET /diag` → HTTP 200 with
     `self_eval { staleness, stale_window:10, stale_threshold:8, composition_count, nudge_count,
     last_nudge_at, last_nudge_action }` and `e2ee.critic_model` / `e2ee.critic_enabled`.
   - ✅ `brainrot-box/flow.md` — #92 section appended.

3. **"PR base staging, title carries (#NN)."**
   - ✅ PR #97 `ready-92 → staging`, title ends `(#92)`.

## Design decisions (the 3 questions the prior BLOCKED comment flagged — now resolved)

- **retireMostUsedTool vs starter-protection/LRU**: skips `STARTER_NAMES` (a self-nudge must not burn
  the hand-built toolbox — guaranteed palette floor intact, asserted by the escalation test) but does
  NOT protect in-use tools (the point of a retire is to force the compositor off its crutch). Stays
  synchronous, no archive (a deliberately-retired crutch isn't re-seeded).
- **staleness vs idle-shutoff**: `observeComposition` hooks the compositor weave lane (called after
  `compositorTurn`); it idles automatically when `stopWeave` stops the lane — **no new timer**,
  composing with #90 the same way #83/#88 do.
- **critic / brief.avoid vs new brief machinery**: `brief.avoid` is a one-shot toolsmith steer
  (read + cleared in `toolsmithTurn`); `distill()` and `judgeRecent()` **preserve** an in-flight
  `avoid` across brief rewrites so it survives until the toolsmith consumes it. The critic folds a
  one-line verdict into `brief.direction`; default OFF (`CRITIC_MODEL` / `ENABLE_CRITIC`).

## Evidence tier — Tier 1 (API/behavior)

The new `/diag` surface + the staleness loop, proven by (a) the deterministic offline unit tests
(the exact nudge path) and (b) the live local HTTP `/diag` returning the new fields. Not Tier 0 (new
API surface + behavior). Not a clean Tier 2 — see below.

## What I could NOT verify (honest)

- **Deployed-staging Tier-2 walk is still operator-credential-blocked** — but NOT structurally
  impossible (correcting the prior PR's misdiagnosis). A raw-fetch probe (2026-08-01) shows the route
  is alive: `https://pod.dstack.soc1024.com/goodpoint-box/` → **HTTP 200 `<title>the brainrot
  box</title>`** (the rename is served). But `/goodpoint-box/diag` returns `otter … challenge_pending`
  (409 step-up) — the same Otter step-up + e2ee-model blocker as #80/#83. A live self-nudge in the UI
  needs the full Otter→judge→toolsmith→compositor pipeline (operator-held Otter token + working
  NEAR/Chutes e2ee; browning out per #93/#94). Proven deterministically by the unit test instead.
- **This branch is not on the serving snapshot yet.** The deployed `/diag` has no `self_eval` block
  (pre-merge snapshot). Merge → staging re-sync + redeploy is the operator step that surfaces it.
- **No browser screenshot.** The envoy bridge screenshot path timed out for the prior worker; per the
  no-blank-image rule none is attached. The UI hook (`#selfState` span + `self-eval` activity handler)
  is a 2-line additive change verified by reading the served HTML + the unit test asserting the event
  shape the span renders.
