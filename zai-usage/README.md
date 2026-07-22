# zai-usage

A sample OAuth3 relying-party app that reads the **z.ai GLM Coding Plan** usage dashboard —
5-hour quota %, weekly quota % (+ reset), total tokens (7d), and per-model breakdown — through
a scoped, revocable token from the OAuth3 node. The app never sees the z.ai API key; the TEE pod
does the authenticated read against `https://api.z.ai`.

This is the operator-asked "I definitely need an app for my ZAI subscription" (issue #76). It also
exists to feed the swarm's own quota gate (`paseo-batch` `quota.sh` / `harness/quota-gate.sh`)
**provider-truth** numbers instead of estimates from paseo token counts.

## Status — shipped subset (scope-down; see issue #76)

This PR ships the **app half**. Two pieces remain (commented back on the issue):

1. **The `zai` cookie-jar plugin in `oauth3-server`** (`server/plugins/zai.ts`) — **not yet
   shipped.** Without it, Connect reads an honest error (plugin not registered / route 404),
   never fake numbers. Until it lands, this app proves the **render path** with a clearly labeled
   SAMPLE (the "Preview sample render" button).
2. **Owner syncing the real z.ai session** (the `zai_token` bearer under the jar) — operator step.

## App↔plugin interface contract (cross-repo — binding for the oauth3-server side)

```
GET /oauth3/api/zai/quota      header: Authorization: Bearer <scoped token>
→ 200 { plugin:"zai", data:{
          fiveHourPct, weeklyPct, weeklyResetIso, totalTokens7d,
          models:[{model,tokens}], searchReader?:{used,limit,unit}
      } }
→ 409 { error:"challenge_pending", challengeId }   (step-up; the helper polls)
→ 401/4xx  { error:"<real reason>" }               (terminal; rendered honestly)
```

- **Plugin:** `zai`, scoped read `zai:usage-read`.
- **Jar:** key `zai_token`; `loggedIn(jar)=!!jar["zai_token"]`;
  `headers(jar)={"Authorization":"Bearer "+jar["zai_token"]}`; base `https://api.z.ai`.
- **Upstream (server-side, compose the one response above):**
  - `/api/monitor/usage/quota/limit` → 5h %, weekly % + reset time.
  - `/api/monitor/usage/model-usage?startTime=..&endTime=..` → total tokens + per-model.
  - `/api/monitor/usage/tool-usage?..` → search/reader usage.

## How connect works

Through the **shared `ShareKit.oauth3Connect()` helper** (the #66 pattern, inlined from
`share-kit/share-kit.js`): the probe reads via `ShareKit.oauth3Read`, so a 409
`challenge_pending` / step-up is retryable (polls `GET /api/challenge/:id`), and every other
failure is an honest, readable terminal error — no masking, no fake numbers, no empty-green lie.

## Run

Static single-file app (same shape as `reddit-karma` / `timeline-peek`). Served at its mount root
on webhost-staging. Re-inline the kit after a share-kit update:

```
share-kit/inline.sh zai-usage
```
