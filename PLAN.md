# PLAN — #93 brainrot-box: restore interleave's prompt craft + continuous visual-brief distillation

Base: `origin/staging` · Worktree: `/tmp/app-93` · Branch: `ready-93-v2`

## Acceptance (from the issue, verbatim)
- [x] TOOLSMITH_SYSTEM matches the reference's content (variety directive + 3D math + Path2D + typography present), adapted only for the txt param.
- [x] Distill stage: offline test with a mock LLM shows brief updates from segments without any banger, and a banger still overrides.
- [x] One run against the real staging core (.intake-env) shows briefs changing across a transcript window (log committed; LLM may be mocked).
- [x] deno check clean; flow.md updated; PR base staging, title carries (#NN), ready-to-merge when evidence is in.

## Reality on the box (2026-08-27, probed live)
- The runtime halves of #93 are ALREADY on staging: prompts via PR #104 (merged 2026-07-21),
  distill stage via PR #112 (merged 2026-07-22), both then sanitized/extended by PR #99 (#94,
  2026-08-15). PR #98 (the original #93 attempt) was closed as "Superseded by #104 + #112" —
  its evidence never merged, and no test asserts the #93 interplay. Verified against
  `origin/staging`: TOOLSMITH_SYSTEM carries the full reference content (variety/3D/Path2D/
  typography + txt param) plus the later CRAFT section; `distill()` runs on new segments with
  the 12s gate (interleave's own reference interval; the issue body said 20s, the reference
  and the code say 12s); a banger overwrites `this.brief` (judgeRecent) after any distilled brief.
- Staging HEAD's `server.ts` did NOT parse: `` `timeout after ${${timeoutMs / 1000}s` `` (stray
  `${`, landed in #106's rebase, 09f081f) — `deno check` fails on the base branch. Fixed here
  (one line). The deployed instance predates it (tree `50466b3224a3…`, 2026-08-15) and parses fine.
- Deployed staging instance live at `$TEE_DAEMON_URL/brainrot-box` with real STT/judge/distill
  LLMs; espeak-ng (lib only) synthesizable via ctypes → real-speech `/listen` ingest works
  (whisper conf ~0.89–0.94). `/_api/version` 404s on this daemon; the pin is the daemon's
  tree_hash for brainrot-box + `/diag`.
- `.intake-env` `OTTER_TOKEN` is dead (`{"error":"token delegation invalid"}` against the real
  core) — otter-poll ingest is dead, mic `/listen` ingest is not.

## Build
- [x] tests/server_test.ts: `#93 distill evolves the brief from segments with no banger, and a banger still overrides` (mock lane provider + judge override)
- [x] server.ts: fix the `${${` template syntax error blocking `deno check` (#106 rebase typo)
- [x] .evidence/issue-93/: tts.py (ctypes libespeak-ng), run.sh driver, staging-run.log

## Verify
- [x] `deno check server.ts tests/server_test.ts` clean
- [x] `deno test --allow-all`: 49/49 (48 inherited + the new #93 test)
- [x] Deployed-staging run (REAL LLMs, no mocks): 6 speech windows → 6 distinct evolving briefs
  + 8 real score-8 bangers in the ledger (override path firing live); pinned tree `50466b3224a3…`
