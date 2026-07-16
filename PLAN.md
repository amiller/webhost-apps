# PLAN — issue #76: zai plugin + zai-usage app (GLM Coding Plan quotas)

Base: `staging`. Repo: `amiller/webhost-apps`. Evidence tier: **Tier 2** (new user-visible app).

## Scope split (cross-repo; LESSONS cross-repo rule → contract written into the app + PR + issue comment)
- **`zai` cookie-jar plugin** + `/oauth3/api/zai/quota` JSON route → lives in `oauth3-server`
  (`server/plugins/zai.ts`). NOT in this repo. **Does not exist yet** (verified: no `zai` in
  `oauth3-server/server/plugins`). This is the documented remaining step.
- **`zai-usage` static app** (this PR) → `webhost-apps/zai-usage/index.html`. Pure static,
  same shape as `reddit-karma` / `timeline-peek`. Uses the shared `ShareKit.oauth3Connect`
  helper (the #66 pattern), not hand-rolled connect.

## App↔plugin interface contract (binding for the oauth3-server side)
- `GET /oauth3/api/zai/quota`  (header `Authorization: Bearer <scoped token>`)
  → `{ plugin:"zai", data:{ fiveHourPct, weeklyPct, weeklyResetIso, totalTokens7d,
     models:[{model,tokens}], searchReader?:{used,limit} } }`
- Plugin `zai`; jar key `zai_token`; `loggedIn(jar)=!!jar["zai_token"]`;
  `headers(jar)={"Authorization":"Bearer "+jar["zai_token"]}`; upstream base `https://api.z.ai`;
  scoped read `zai:usage-read`. Upstream calls (server-side, compose the one response):
  `/api/monitor/usage/quota/limit`, `/api/monitor/usage/model-usage?startTime=..&endTime=..`.

## Acceptance (from issue #76 `## Acceptance`) → checkboxes
- [ ] Owner connects z.ai session via extension jar-sync; app shows SAME quota % as dashboard
      (live, owner-verified). → **OUT of this repo's reach** (needs the oauth3-server `zai`
      plugin + owner jar-sync). Proven here via a clearly-labeled SAMPLE render of the exact
      cards, + the honest real connect/read error state (no masking). Remaining step commented.
- [ ] JSON endpoint returns quota numbers for machine use; with no jar, honest "connect z.ai"
      state. → The JSON endpoint IS the plugin's `GET /oauth3/api/zai/quota` route (oauth3-server).
      This PR ships the consumer + the honest no-jar / not-registered states.

## Build steps
- [ ] `zai-usage/index.html` — grape-acid tokens (webhost register), ShareKit.oauth3Connect,
      ShareKit.oauth3Read(`/api/zai/quota`), quota cards, labeled SAMPLE render, honest states.
- [ ] Inline share-kit via `share-kit/inline.sh zai-usage`.
- [ ] `zai-usage/README.md` — contract + remaining steps.
- [ ] Add `zai-usage` row to `REGISTRY.md` (self-register deploy + evidence gate).
- [ ] `node --check` the app script; eyeball the inlined kit block.

## Verify (Tier 2, honest subset)
- [ ] Serve the branch; drive the real page via the envoy bridge; assert content; screenshot.
- [ ] Deploy to staging via `scripts/deploy-static.sh` (token on this box) so the landing page +
      real diagnostics are on the deployed URL.
- [ ] `.evidence/issue-76/` screenshots + flow.md; embed in PR body.

## Ship
- [ ] commit + push `ready-76`; `gh pr create --base staging`; swap `ready → in-review` on #76.
