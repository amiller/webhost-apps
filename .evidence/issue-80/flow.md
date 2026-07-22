# Issue #80 Evidence

Tier target: Tier 2 (new user-visible app).

## What was verified

- `deno check goodpoint-box/server.ts` passed.
- `deno test goodpoint-box/tests/server_test.ts` passed.
- `goodpoint-box/public/index.html` inline script passed `node --check`.
- Local browser render through the real bridge reached `http://172.17.0.1:8094/app`, asserted:
  - `document.title === "goodpoint-box"`
  - page contains `Live transcript`
  - page contains `Good points`
- Screenshot: `.evidence/issue-80/01-local-ui.png`.

## What could not be verified

- The real staging-core Otter ingestion run reached `OAUTH3_CORE` from `~/paseo-batch/.intake-env`, but the core returned `challenge_pending`; see `.evidence/issue-80/otter-ingest.json`.
- Staging deployment was not run because this box does not have `NEAR_API_KEY` / `CHUTES_API_KEY`; the deploy script refuses missing keys as required by the no-fallback rule. See `.evidence/issue-80/deploy-attempt.txt`.
- Because the signed-in live Otter value state and deployed staging UI were blocked, this branch is not honest Tier 2 complete and must not be labeled `ready-to-merge` until the operator approves the challenge and runs deployment with model keys.
