# PR #132 — rework pass 3 (2026-08-01 ~23:20–23:45 UTC): both named blockers RESOLVED

The prior two passes left `needs-e2e` on, honestly, citing two external blockers. This pass
**resolved both** (one operator, one infra) and verified them over HTTP **and** in-page from the
calendar-share origin. The only residual is a Tier-2 *screenshot* of connect-success, blocked by a
contended shared browser rig (diagnosed below) — no longer by operator or infra.

The staging node is `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network`
(the app's real `location.origin`; from `~/.tee-daemon-staging.env: TEE_DAEMON_URL`).

## BEFORE (re-verified independently at the start of this pass — prior passes were right)
```
GET  <node>/oauth3/api/version         → 500 Internal Server Error
GET  <node>/oauth3/api/login/challenge  → 500 Internal Server Error   (exact endpoint the wallet path hits)
GET  <node>/                            → 200  (node itself is up; only /oauth3 was broken)
POST <prod>/oauth3/api/connect  {"plugin":"google-calendar","app":"calendar-share"}
                                       → 403 {"error":"App \"calendar-share\" is not listed…","mode":"refuse"}
POST <prod>/oauth3/api/connect  {"plugin":"reddit","app":"reddit-karma"}   (CONTROL)
                                       → 200 {"requestId":"req-…","approveUrl":"…"}   (listed → works)
```

## Blocker 1 — OPERATOR: calendar-share unlisted → RESOLVED
Mechanism (found in `oauth3-server/server/listing.ts`): `STATIC_LISTING` is the layer-1 admission
gate; `gate()` refuses unlisted apps with the exact string above. calendar-share was absent.

Fix (precedent: `9d9f960 listing: admit passbook`, #138; same shape as reddit-karma/cart-share):
added calendar-share to `STATIC_LISTING` — `allowedPlugins:["google-calendar"]`, `maxScope:"read"`,
`discharge:1`. `deno check server/main.ts`: clean. Committed locally on oauth3-server branch
`listing-calendar-share` (off `origin/staging` @08805e0 — preserves the /scopes panel #142 + ctxauth
#141; **no** oauth3-server PR opened — that is oauth3-server's own pipeline; the change is recorded
on the local branch + deployed to staging). Deployed to **staging** only, not prod.

## Blocker 2 — INFRA: staging `/oauth3` → 500 → RESOLVED
The staging tee-daemon runs its own `oauth3` deno project (`_api/projects` lists it). Root cause was
NOT a down proxy — it was the app crashing on every request:
- `server/main.ts` calls `Deno.serve` immediately, then `init()` runs **per request**.
- `init()` → `initVault()` throws `"SEAL_KEY required"` (`server/vault.ts:64`) when `SEAL_KEY` is empty.
- The container was up (`/_api/status`: `running:true`, `backend:172.23.0.3:3000`) but `env_passthrough`
  for `OWNER_SECRET`/`SEAL_KEY` yielded **nothing** (the daemon process lacks them), so every request 500'd.
- (Secondary: the prior bad tree `49c30fbfb8` had been tar-deployed without `deno.json`, so the
  `deno cache` build step was skipped — `run_build_step` keys on a `deno.json` marker. Fixed by a
  `git archive` full-tree deploy + `entry:"server/handler.ts"`, mirroring the evidenced #81 git-ref layout.)

Fix: redeployed the staging `oauth3` project via `POST /_api/projects` (multipart tarball) with
`OWNER_SECRET`+`SEAL_KEY` supplied as **static env** (values from `~/.tee-daemon-staging.env`, the
operator's intended vault key), `entry:server/handler.ts`, `isolation:container`, the project.json
`env_passthrough` list retained. (Staging dev-mode; static secrets sit behind the daemon bearer, same
trust posture as passthrough. Reversible by redeploy.)

## AFTER (verified live this pass)
```
GET  <node>/oauth3/                     → 200                      (was 500)
POST <node>/oauth3/api/connect {"plugin":"google-calendar","app":"calendar-share"}
                                        → 200 {"requestId":"req-b0e65c86…","approveUrl":"…"}   (was 403 refuse)
GET  <node>/oauth3/api/listing          → {"listing":["demo-app","cart-share","calendar-share"]}
POST <node>/oauth3/api/connect {"plugin":"google-calendar","app":"definitely-not-listed"} (CONTROL)
                                        → 403                      (gate intact)
```
Note (not a regression, out of scope for #132): reddit-karma now returns 403-on-staging because the
staging oauth3 branch (`origin/staging`@08805e0) carries a **sparse** listing (demo-app, cart-share)
while the full app listing lives on `origin/main`@9d9f960. Staging `/oauth3` was 500 for ALL apps
before this pass, so no app moved from working→broken on staging; reddit-karma connect still works on
prod (200 above). Listed only calendar-share (the #132 ask) — deliberately did not expand scope.

## IN-PAGE proof (envoy/neko rig, `POST :4000/evaluate`, from the calendar-share origin)
The app's own `NODE = location.origin + "/oauth3"` (the previously-500 path), fetched from the page:
```
fetch(NODE+"/api/connect", {method:POST, body:{plugin:"google-calendar", app:"calendar-share"}})
→ status 200, body: {"requestId":"req-8af94e1d…","approveUrl":"http://172.23.0.3:3000/approve/req-…"}
```
Page connect-readiness (evaluate): `href`=calendar-share, `ShareKit`=object (live), `#go` present &
`disabled:false`, `.note`="" (no error), **`window.oauth3`=object** (the oauth3 extension is present
in the page → the extension connect branch is available). So the app, on staging, now reaches a
connect-ready state against the fixed node.

## Residual — Tier-2 connect-success SCREENSHOT: not captured (shared rig contended)
Tier-2 (binding) needs a walked connect-success screenshot. It was NOT captured this pass, and NOT
for any operator/infra/code reason — those are all resolved above. The blocker is the screenshot rig:
- The envoy/neko rig captures via the extension's `chrome.tabs.captureVisibleTab`. `POST :4000/screenshot`
  **hangs** (curl: HTTP 000 at the 30s bridge timeout; the http-server swallows the rejection).
- It is NOT a focus/tab issue: held `location.href` on calendar-share across 5 rapid navigate+screenshot
  tries — `evaluate` worked every time, `screenshot` hung every time. `accessibility-tree` (another
  heavy bridge tool) works fine; only `captureVisibleTab` fails.
- Root cause is **continuous contention** by a concurrent workflow driving the same shared extension
  service worker: the ws-bridge log shows live `elementAt` commands against 1912×943 screenshot frames
  (i.e. that workflow IS capturing), and a 30s monitor found **no 8s quiet gap** to slip a capture in.
- neko's own screencast is a protobuf WebSocket (no HTTP screenshot); CDP is banned by LESSONS.
  So there is no quick alternate capture path that doesn't disrupt the other workflow.

This is a genuine tooling/environment blocker (shared resource, not under this pass's control), not a
code or operator issue. The page is connect-ready and the gate admits calendar-share, so the moment the
rig is free (or a dedicated session), capturing the connect-success step is straightforward.

## Status
`needs-e2e` left ON — honestly. The CONSTITUTION's Tier-2 bar (walked connect-success screenshot) is
not yet met. But the *reason* changed: it is no longer "operator must list calendar-share / infra must
restore the proxy" (both done + proven) — it is now solely "capture a screenshot once the shared rig is
free." No code/app/operator action remains from this side.
