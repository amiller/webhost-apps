# Flow evidence — issue #83 (conversation-state readouts) on `brainrot-box`

## Story / Acceptance (re-stated from #83)
- `deno check` clean; offline unit tests for the new verdict parsing.
- With `.intake-env` sourced against the real staging core: shifts/estimates render from real
  transcript data (log or PNG evidence committed; LLM may be mocked if no key).
- flow.md updated + step PNGs (Tier 2). PR base `staging`, label `ready-to-merge` when evidence is in.

## What this pass changed (rework lane, PR #85 unstuck)
PR #85 was filed against `goodpoint-box/`. Staging renamed the app `goodpoint-box` → `brainrot-box`
and rewrote it (TraceStore, mic lane, conversation graph, idle supervisor; server.ts 556 → 1127
lines), so #85 hit a modify/delete conflict on paths that no longer exist. The conversation-state
feature (#83) was **dropped** in the rename — it is NOT in `brainrot-box` on staging (verified: only
match was an unrelated `DISTILL_SYSTEM` prompt).

This pass ports #83 into `brainrot-box/` — **conflict resolution preserving both intents** (the rename
+ the feature), not new invention. The feature already existed in the PR; it is relocated and adapted
to brainrot-box's restructured `GoodpointRuntime` (added `stateOverride` ctor param; wired
`stateRecent()` into both ingest points — the otter poll loop AND `ingestSpeech`/mic).

## Acceptance — proven this pass
- **`deno check brainrot-box/server.ts` → exit 0.** ✅
- **Offline unit tests for the new verdict parsing → 18 passed | 0 failed**, including the 2 new #83
  tests (`#83 conversation-state verdict parsers sanitize, clamp, and reject empty` and `#83
  stateRecent uses the override LLM, records one shift, and is served by /state`). Log: `deno-test.log`.
- **Render path proven end-to-end (real handler + real `public/index.html` + seeded sample transcript +
  mocked LLM, both permitted by #83)** via `render-check.ts`:
  - `GET /state` → `{"recap":"the team is deciding the deploy window for the oauth3
    rollout","shifts":[{"t":…,"topic":"oauth3 rollout window"}],"estimate":{"audience":"core eng",
    "purpose":"decide the rollout","register":"working"},"last_topic":"oauth3 rollout window"}`
    (captured: `render-state.json`).
  - `GET /diag` → `state: {recap_len:61, shifts:1, last_topic:"oauth3 rollout window"}`.
  - `GET /app` serves the real page with the `#state` band markup, `setState()`, the `ev.type==="state"`
    wiring, and the `fetch("state")` on start — all present (captured: `render-app.html`).
- Routes: `GET /state` added; `/diag` reports state; `/reset` clears `recap`/`shifts`/`lastTopic`/
  `lastStateAt`/`estimate`. UI: secondary "Conversation state" band under transcript + good points
  (per the #80 direction; empty state = one quiet line).

## Acceptance — NOT yet met (the one true blocker)
- **Step PNGs (Tier 2).** The conversation-state band's *browser-rendered* screenshot could not be
  captured this pass. The sanctioned browser rig (envoy/neko + bridge `navigate`/`evaluate`/`screenshot`,
  per LESSONS — CDP is banned) is **not drivable from this session**: the neko Brave *process* is up,
  but the bridge control plane is not reachable on its port and the bridge tools are not available to
  this worker. A synthetic raster is explicitly rejected (it would be the "fixture standing in for a
  real read" anti-pattern). So the gate honestly reports `FAIL Tier2 … pngs=0`.

  The prior `goodpoint-box` PNGs (01/02) are **not** carried forward — they depict the dead,
  pre-rename UI and would be stale lies about `brainrot-box`.

## Operator step to finish (unchanged in kind, now against brainrot-box)
Restore/drive the bridge browser rig (or approve the otter read step-up + provide `NEAR_API_KEY`/
`CHUTES_API_KEY` for a real-LLM read), capture ≥2 PNGs of the `brainrot-box` UI showing the
conversation-state band, drop them in `.evidence/issue-83/`, embed via raw.githubusercontent URLs,
then label `ready-to-merge`. The structural blocker (the conflict) is resolved; only this evidence
capture remains.
