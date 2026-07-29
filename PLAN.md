# PLAN — feedling #49: test-mode (ping on ANY watch)

Prior worker already implemented the change on `ready-49` (commit d83bf86). Verified the diff is
complete and correct vs. acceptance; base is an ancestor of staging (PR merges as 1 commit).
This iteration: verify by tier and ship.

> **Rework pass (2026-08-01):** PR was `CONFLICTING` + `needs-e2e`. Rebased onto staging (impl
> was already in staging → impl commit dropped as empty; branch now = tests + evidence + PLAN).
> Captured the pixel screenshot (bridge healthy this run). Push delivery stays operator-run.

## Acceptance (from issue #49)
> With verbose mode on and a push subscription active: watch ONE regular (non-short) YouTube
> video briefly, and within one poll interval receive a push naming that you just watched.
> Screenshot the received notification (or the [push] server log line `trigger=watch_detected
> sent>0`) in the PR.

## Tasks
- [x] Confirm #49 open, no PR, has `## Acceptance` (merge-gate grep) — PASS
- [x] Reuse prior worker's complete implementation on ready-49 (re-validated diff)
- [x] Parse-check all .TS (`deno check`) — exit 0
- [x] Unit-test the NEW decision logic (`pendingWatchDetected` + verbose-mode activity branch + per-session re-arm) against the real production functions — `deno test` → 4 passed
- [x] Deploy feedling-web to webhost-staging — feature already present on live staging (verified `GET /api/verbose` → 200)
- [x] Tier 1 HTTP transcript on deployed staging: `POST /api/verbose {enabled:true}` → `GET /api/verbose` == `{"verbose":true}` (new endpoint = version pin)
- [x] Tier 2 walked flow: envoy-bridge screenshot of UI `TEST MODE: ON` captured (navigation-verified) — `.evidence/issue-49/01-test-mode-on.png`
- [x] Commit test + evidence; PR open (base staging); issue labelled `in-review`
- [ ] STILL NOT ready-to-merge: the watch→push delivery needs the operator's live YouTube watch + a real push sub (feedling must be approved on the pod first). `needs-e2e` stays ON for this step — see flow.md §4.
