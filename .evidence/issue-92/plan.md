# PLAN — unstick PR #97 (issue #92): port staleness self-eval into brainrot-box

## Diagnosis (Step 0)
- PR #97 (`ready-92` → `staging`) is **CONFLICTING/DIRTY**, label `needs-e2e`.
- Collision: `goodpoint-box/` was **renamed to `brainrot-box/`** on staging and rewritten
  (610→1654 lines). The PR's `goodpoint-box/*` edits are modify/delete vs staging.
  `git ls-tree origin/staging -- goodpoint-box` = empty. Staleness feature (`grep`=0) was never ported.
- Prior worker BLOCKED (genuine semantic collision) and offered 2 options. Operator directive
  ("Unstick exactly PR #97 — nothing else") = **option 2: re-point `ready-92` at `brainrot-box/`**.
- Freshness guard: owner comment 2026-08-01 > last commit 2026-07-16 → cleared to act.

## Issue #92 Acceptance (gate-checked: HAS `## Acceptance`)
1. Offline test: near-identical compositions trigger a self-nudge; varied run does not.
2. `deno check` clean; `/diag` shows new fields; flow.md updated.
3. PR base staging, title (#NN).

## Port design (decisions on the 3 flagged design questions)
Port the staleness feature from `goodpoint-box/server.ts` (ready-92) into `brainrot-box/server.ts`,
adapting to the re-architected two-lane + idle-shutoff + starter-protected LRU + brief/distill machinery.

- **Q1 retire vs starter-protection/LRU**: `retireMostUsedTool()` SKIPS `STARTER_NAMES` (preserves
  the guaranteed palette floor — a self-nudge must not burn the hand-built toolbox) but does NOT
  protect in-use tools (the point of a retire is to force the compositor off its crutch). Stays
  synchronous, no archive (matches original; a deliberately-retired crutch isn't re-seeded).
- **Q2 staleness vs idle-shutoff**: staleness observation hooks into the **compositor weave lane**
  (`observeComposition` after `compositorTurn`). It idles automatically when the weave lane stops
  (`stopWeave`) — **no new timer**, composes with #90 like #83/#88 do.
- **Q3 critic / brief.avoid vs new brief machinery**: `brief.avoid` is a one-shot toolsmith steer
  (read+cleared in `toolsmithTurn`); `distill()`/`judgeRecent()` **preserve** an in-flight `avoid`
  across brief rewrites so it survives until the toolsmith consumes it. Critic folds a one-line
  verdict into `brief.direction`; default OFF (`CRITIC_MODEL`/`ENABLE_CRITIC`).

## File changes
- [x] `brainrot-box/server.ts`: Cfg(criticModel/enableCritic); Brief.avoid?; runtime staleness state;
  criticOverride ctor param (last); signatureOf/recordComposition/retireMostUsedTool/selfNudge/
  criticTurn/observeComposition; toolsmith avoid steer; distill+judgeRecent preserve avoid; compositor
  lane calls observeComposition; /diag self_eval + e2ee critic fields; /reset self-eval state.
- [x] `brainrot-box/public/index.html`: `#selfState` strip span + `self-eval` activity handler.
- [x] `brainrot-box/tests/server_test.ts`: staleness tests adapted to brainrot ctor.
- [x] `brainrot-box/flow.md`: #92 section.
- [x] `.evidence/issue-92/`: regenerate tests.txt, diag.json, flow.md, plan.md.

## Verify (Tier 1 — API/behavior)
- `deno check brainrot-box/server.ts` exit 0.
- `deno test` all green (existing + new staleness tests).
- Local server `/diag` returns `self_eval{...}` + `e2ee.critic_model`/`critic_enabled`.

## Ship
- Commit on branch off `origin/staging`; `git push --force-with-lease origin HEAD:ready-92`.
- PR #97 comment: explain the port + the 3 design decisions + evidence re-verified.
- Relabel: `needs-e2e` → `ready-to-merge` ONLY if evidence tier is honestly met (Tier 1 here).
