# Evidence — feedling #49 (test mode / ping on ANY watch)

Issue: amiller/webhost-apps#49
Branch: `ready-49` → `staging`.
Staging URL: https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/feedling-web/

> **Rework pass (2026-08-01).** PR #135 carried `needs-e2e` AND was `CONFLICTING`. Two things
> changed this pass:
> 1. **Conflict resolved.** Rebased `ready-49` onto current `staging`. The test-mode
>    **implementation was already in `staging`** (`server.ts`/`store.ts`/`state.ts`/
>    `oauth3-client.ts`/`public/index.html`/`README.md` all already present in `origin/staging`),
>    so the impl commit became empty on rebase and git dropped it. The branch now carries only
>    what staging lacks: `logic_test.ts` (the unit tests) + this evidence + `PLAN.md`. No work
>    lost; the feature is live either way. `deno check` + `deno test` → 4 passed on the rebased tree.
> 2. **Pixel-screenshot blocker CLEARED.** The envoy bridge `screenshot` tool is healthy this run
>    (live-capture verified: a different page yields a different image; the feedling shots are
>    identical only because the static page renders the same in the same state). Captured
>    `01-test-mode-on.png` — see §3 below.
>
> The `watch_detected` push **delivery** is still operator-run (§4) — that genuinely needs the
> operator's live YouTube watch and is not producible by a worker. `needs-e2e` is therefore left ON
> for the push step; the visual + logic + HTTP evidence below is everything reachable on-box.

## Rework pass 5 (2026-08-02) — ROOT CAUSE of the connect wall found + FIXED (the real unstick)

Passes 1–4 all hit `App "feedling" is not listed` and concluded the operator still needed to
approve feedling on the pod. **That diagnosis was wrong.** The operator had ALREADY listed the
app — as `feedling-web` (its deploy / registry name). The wall had two worker-fixable defects:

1. **Wrong appId in the client.** `oauth3-client.ts` POSTed `app:"feedling"`; the pod catalog
   lists `feedling-web`. The gate refuses any unlisted id, so connect was always 403 `refuse`.
2. **Mis-pointed `OAUTH3_NODE` in the deployed env.** The running build had
   `OAUTH3_NODE=https://78ffc78c…phala.network/oauth3` (the CVM's *own* minimal oauth3, which
   lists only `demo-app`/`cart-share`/`calendar-share`). Every canonical source — `server.ts:163`
   default, the README, and the operator's own `sync-youtube.sh:88` — sets
   `OAUTH3_NODE=https://pod.dstack.soc1024.com/oauth3`, the only node where `feedling-web` is
   listed. The self-referential value was a deploy-template artifact.

**Fixes (this PR / this deploy):**
- `oauth3-client.ts`: `app:"feedling"` → `app:"feedling-web"` (commit `6c52f86`). `deno check`
  + `deno test` → 4 passed.
- Redeployed feedling-web with `OAUTH3_NODE=https://pod.dstack.soc1024.com/oauth3` (VAPID /
  BASE_PATH / TZ unchanged — echoed from the prior deploy).

**Tier 1 — verified on deployed staging (raw HTTP, no CDP):** the connect handshake now reaches
the APPROVAL step instead of being refused at the listing gate.

Gate proof (the literal gate the app calls):
```
POST https://pod.dstack.soc1024.com/oauth3/api/connect {"app":"feedling"}     -> 403 {"mode":"refuse"} "not listed"
POST https://pod.dstack.soc1024.com/oauth3/api/connect {"app":"feedling-web"} -> 200 {"requestId":"req-…", "approveUrl":"…/approve/req-…"}
```
Live app state on the redeployed build (`ref:ready-49`, `tree_hash:c028be31…`, deployed
`2026-08-02T04:18:02Z`):
```
GET /api/state  ->
  connect.connected : false
  connect.error     : ""                         (was: "App "feedling" is not listed…")
  connect.approveUrl: https://pod.dstack.soc1024.com/oauth3/approve/req-f4299d29e1294464925feb8c10122b8e
  poll.error        : "approve feedling on your pod: <same approveUrl>"
  verbose           : true   (POST /api/verbose {enabled:true} restored; endpoint pins this build)
GET /api/subs   -> subs:0      GET /api/pushes -> pushes:0
```
The hard wall is gone. What remains (§4) is the operator's live watch→push mile, which now
actually works once they approve + sync cookies + subscribe + watch.

## Acceptance (from the issue)
> With verbose mode on and a push subscription active: watch ONE regular (non-short) YouTube
> video briefly, and within one poll interval receive a push naming that you just watched.
> Screenshot the received notification (or the [push] server log line `trigger=watch_detected
> sent>0`) in the PR.

## What I verified on this box

### 1. Unit test of the NEW decision logic — `deno test logic_test.ts` → 4 passed
Tests the real production functions in `store.ts` (no mocks):
- verbose-mode activity keys off TOTAL history growth (a regular-video watch with shorts flat
  IS activity; normal mode treats shorts-flat as NOT activity — i.e. normal mode unchanged);
- `watch_detected` fires ONCE per session on the first positive total-delta and returns the delta
  (so the push can name "N new item(s)");
- zero total-delta never fires (normal-mode guard);
- the trigger re-arms on a NEW session after the 15-min gap.

### 2. Tier 1 HTTP transcript on deployed staging (verbose toggle is live)
Deployed `feedling-web` to webhost-staging at commit `d83bf86` (staging oauth3 node + fresh
staging VAPID so push is wired). The new `GET/POST /api/verbose` endpoint **only exists in the
#49 build** — its 200 response pins this as the deployed commit:

```
GET  /api/verbose                         -> 200 {"verbose":false}
POST /api/verbose {"enabled":true}        -> 200 {"verbose":true}
GET  /api/verbose                         ->     {"verbose":true}
GET  /api/state  (extracted)              -> {"verbose":true, ...}
POST /api/verbose {"enabled":false}       -> 200 {"verbose":false}   (restore default)
```

### 3. Tier 2 — walked flow via the envoy bridge (navigation-verified, PIXEL CAPTURED)
Drove the real browser (envoy/neko, no CDP) to the staging URL. Per LESSONS.md
("verify navigation, not just capture") `location.href` is asserted before AND after the
screenshot — it did not drift. `evaluate()` asserts the acceptance content at the real URL:
```json
{"href":"https://78ffc78c...phala.network/feedling-web/",
 "title":"feedling",
 "verboseBtn":"TEST MODE: ON",
 "foot":"test mode · poll: 60s idle / 60s while watching · pings on ANY watch"}
```
Cross-check `GET /api/verbose` -> `{"verbose":true}`.

**Pixel screenshot (this pass):** `01-test-mode-on.png` — `test -s` OK (54957 bytes, 1912×943,
valid PNG, non-blank: pixel min 0 / max 250 / stdev 13.9). Captured between two href assertions
that both returned the feedling-web URL with `TEST MODE: ON`, so the frame is the verified
state. The envoy `screenshot` tool is confirmed live (not cached): navigating to a different
page returns a different image.

## What I could NOT verify on this box (honest)

1. **`watch_detected` push delivery — operator-run (the connect wall itself is now FIXED, see
   pass 5 above; only the live watch/subscribe mile remains).** Firing `trigger=watch_detected
   sent>0` (the acceptance's alternative evidence) requires the operator's LIVE YouTube watch
   growing the history total AND a registered push subscription. After pass 5 the app reaches a
   live `approveUrl` (`pod.dstack.soc1024.com/oauth3/approve/req-…`) instead of a listing refuse,
   but a worker cannot: (a) approve the connect signed in as the operator's subject, (b) sync the
   operator's YouTube cookies to the pod (`sync-youtube.sh` — the pod currently holds 0 youtube
   tokens), (c) grant a real-browser push subscription (`/api/subs` → 0), or (d) watch a video on
   the operator's behalf. So `needs-e2e` stays ON honestly — but the operator's path is now real,
   not walled:
   1. open the approveUrl from `/api/state` while signed in → approve `feedling-web` (binds a
      scoped youtube token to the operator's subject);
   2. run `sync-youtube.sh` (or the extension) so the pod's youtube jar is populated;
   3. open the staging URL → **enable push** → grant notification permission (`/api/subs` non-empty);
   4. watch ONE regular (non-short) YouTube video (verbose is already ON). Within ~60s expect
      `/api/pushes` → entry `trigger:"watch_detected"`, `sent>0`, and stdout
      `[push] trigger=watch_detected sent>0`.
   The decision logic that produces that line is unit-tested in §1 and unchanged.

The feature is fully implemented (and already present on staging), parse-checked, unit-tested,
its verbose toggle verified live over HTTP, and its UI captured as a pixel screenshot this
pass. The single remaining gap is the operator's live watch→push delivery.
