# PLAN — issue #80: goodpoint-box

Base: `staging`. Repo: `amiller/webhost-apps`. Evidence tier: **Tier 2** (new user-visible app).

## Acceptance
- [x] `deno check goodpoint-box/server.ts` clean.
- [x] Offline unit tests pass: otter cursor/dedup logic, judge JSON parse + threshold, `/goodpoints` ledger.
- [ ] One run against the REAL staging core (`.intake-env` sourced) shows live segments ingested, with committed evidence. Blocked: core returned `challenge_pending`.
- [x] `goodpoint-box/flow.md` + step PNGs committed.
- [ ] PR base `staging`, title carries `#80`, label PR `ready-to-merge` once evidence is committed. Not ready: Tier 2 live/deployed evidence is blocked.

## Binding Operator UI Direction
- [x] Flowing live transcript is prominent and always moving.
- [x] Good-point quotes are high-contrast, large, and persistent; no skinny right rail.
- [x] Canvas remains the brainrot layer.
- [x] Toolsmith/compositor panes are demoted to pulse dots and one-line statuses.
- [x] No steering text input; app auto-starts on load; popout is the obvious button.
- [x] No intro rows or placeholder rows.
