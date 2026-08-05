# Evidence — feedling #49 (test mode / ping on ANY watch)

Issue: amiller/webhost-apps#49
Branch: `ready-49` → `staging`.
Staging URL: https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/feedling-web/
Running deploy (connected + verbose): https://pod.dstack.soc1024.com/feedling-web/

## Rework pass 7 (2026-08-05, 11:10Z) — ACCEPTANCE MET live: real watch → `watch_detected` → `sent>0`; `needs-e2e` OFF

The operator performed the one action passes 1–6 had been blocked on (watch a video on the
connected account). The verbose poller fired `watch_detected` within one poll interval, exactly as
the acceptance specifies. Nothing below is inferred — every line is server-side state read over
HTTP from the deployed pod after the watch. Full transcript: `02-watch-detected-live.txt`.

### The acceptance line, live
The issue's Tier-2 acceptance offers an alternative to the notification screenshot: the
`[push]` server log line `trigger=watch_detected sent>0`. Its durable form is the `/api/pushes`
record:
```
2026-08-05T11:10:35Z  trigger="watch_detected"  sent=2  pruned=0
      endpoints: fcm.googleapis.com HTTP 201 ok=true | fcm.googleapis.com HTTP 201 ok=true
      body="you watched something just now — 1 new item(s)"
```

### Why this is the REAL signal (not the migration false positive)
- It correlates, to the second, with a genuine `headId` change in `/api/state`:
  `7LP8WvIxPg8 → UWP9hQu8oZc` at `2026-08-05T11:10:35Z`. The migration FP (`05:17:21Z`) was a
  missing-baseline artifact fired *before* the guard commit `297f013`; this fired ~6h later,
  post-guard, off a real head change.
- `totalCount` was **pinned at 199** across that change (the render-window defect, live). Under
  the `totalDelta` signal that `origin/staging` still ships, this watch reads `totalDelta=0` and
  **never fires**. Only this branch's `headWatchDelta`/`headId` signal caught it — so merging
  delivers the working detector, not just the `appId` line.

### Guards verified live in the same window
- **No false positive while idle:** 22 consecutive polls `10:48:14Z`–`11:09:34Z` held
  `headId=7LP8WvIxPg8` flat; zero `watch_detected`.
- **Once-per-session holds:** a SECOND head change followed at `11:12:37Z`
  (`UWP9hQu8oZc → P8Mjz1M6fww`) and **no** new `watch_detected` fired — still exactly 1 this
  session. `pendingWatchDetected` re-arms only on a new session.
- **Delivery proven end-to-end:** both live FCM subs (`/api/subs` → 2) returned **HTTP 201**.

### Redaction (LESSONS 2026-07-11)
This is a PUBLIC repo. The committed transcript carries trigger + count + `headId` (public
YouTube video ids, already present in earlier passes) + timestamps only. The watched video
**titles** and the full item list are the operator's personal watch history and are OMITTED; the
true value-state was read in-session but kept out of the commit.

### Verdict
`needs-e2e` → OFF; `ready-to-merge` ON. The Tier-2 acceptance is satisfied by its own alternative
clause (`trigger=watch_detected sent>0`), proven live on deployed staging against this branch's
commit. Not merged, not closed — promotion stays operator-reviewed.

---

## Rework pass (2026-08-05) — render-window defect FOUND + FIXED; push delivery PROVEN live; `needs-e2e` stays ON

Every prior pass concluded `watch_detected` was blocked only on the operator's live watch. That was
**incomplete**: the feature's count-growth signal was provably broken for an established account, so
`watch_detected` would **never fire even on a real watch**. The acceptance could not have passed.
This pass found the defect at the code level, fixed it, redeployed, and verified live.

### The defect (code-level, not a guess)
- `oauth3-server/server/plugins/youtube.ts` `listItems`/`parseHistory` parses **only** the initial
  `ytInitialData` render — it does **not** follow continuation tokens (the file's own header
  documents this render-window limitation). So `items.length` is bounded by the first-render batch.
- `shortCheck()` set `totalCount = items.length`; `server.ts` keyed verbose activity +
  `watch_detected` off `totalDelta = totalCount − prevTotalCount`.
- For an established account the window is pinned. **Live proof (this run, pod, raw HTTP):**
  `totalCount` read **199 → 199** across two polls 70 s apart (headId stable, `watching:false`).
  A new watch adds to the head and scrolls one off the tail → `totalCount` stays flat →
  `totalDelta ≈ 0` → `watch_detected` never fires. This is exactly why `/api/pushes` had **no**
  `watch_detected` across ~77 prior passes.

### The fix (commits `1a3639e` + `297f013` on `ready-49`)
Key the watch signal off a **HEAD-ITEM id change** instead of total-count growth. A new watch
(regular, short, or a rewatch) lands at history position 0, so `headId` changing is reliable **even
when `totalCount` is window-pinned**. Normal (shorts-only) mode is byte-for-byte unchanged.
- `oauth3-client.ts`: `ShortCheckResult.headId = items[0]?.id`; `totalCount` kept + logged only.
- `state.ts`: `Snapshot.headId`; pure `headWatchDelta(prev, cur)` that **seeds to 0** when either snap
  lacks a headId (first poll / migration from a pre-headId build) — see the migration note below.
- `server.ts`: `headDelta = headWatchDelta(prevSnap, snap)`; verbose `hasActivity = headDelta > 0`;
  `pendingWatchDetected(hasActivity, headDelta)`. `totalDelta` still computed + logged as a contrast.
- `logic_test.ts`: **10 passed** (was 4), incl. a REGRESSION test proving `totalCount` flat (199→199,
  `totalDelta` 0) still fires on a head change, and a migration regression proving a pre-headId
  `prevSnap` does **not** fire.

### Live verification on the deployed pod (`pod.dstack.soc1024.com`, Bearer `~/.tee-daemon.env`)
State-preserving redeploy (multipart POST, **no DELETE** — the daemon `ensure_volume`s
`tee-projdata-feedling-web` idempotently at `/data:rw`; no `remove_volume` exists). Build pin:
`ref:ready-49`, `tree_hash:e9865bdf40d35409b177849006de5b746b6ccb691a191867f96e2aa4bf1c2a42`,
`deployed_at:2026-08-05T05:21:08Z`, `isolation:container`.

| probe | result |
|---|---|
| `GET /api/verbose` | `200 {"verbose":true}` |
| `GET /api/state` newest snap | now carries **`headId`** (was absent pre-fix) |
| `totalCount` across 2 polls 70 s apart | **199 → 199** (the windowing defect, live) |
| `headId` across same 2 polls | `7LP8WvIxPg8 → 7LP8WvIxPg8` (**stable when idle ⇒ no false positive**) |
| `GET /api/subs` | **2 FCM** (survived both redeploys — `/data` persisted) |
| `connect` / `poll.error` | `connected:true` / `""` |
| forced `/api/poll-now` → `watch_detected` count | **unchanged** (migration guard holds; no spurious fire) |
| `deno check` + `deno test logic_test.ts` (clean worktree) | exit 0 / **10 passed** |

### Push delivery PROVEN live (new this run) — and an honest caveat
The first headId deploy (pre-guard) fired **one** `watch_detected` on its first poll (`sent:2`, both
FCM endpoints **HTTP 201`) because the pre-headId persisted snaps made `prevSnap.headId` look like a
change. That was a **migration false positive, not a real watch** — so it is **NOT** the acceptance
evidence, and I am not counting it as one (no-fallbacks, binding). It does, however, prove for the
first time what ~77 prior passes could only infer: the `watch_detected → pushAll → FCM` delivery
pipeline works end-to-end. The guard in `headWatchDelta` (commit `297f013`) prevents a recurrence.

### `needs-e2e` stays ON (true external blocker — honestly)
The Tier-2 acceptance still needs a **real human watch** on the connected account: a new video at
the head changes `headId` → `headWatchDelta=1` → `watch_detected` → `sent>0` over the 2 live FCM
subs (delivery just proven). A worker cannot watch YouTube on the operator's account (no
`SAPISID`/browser jar worker-reachable; no envoy rig on this box; `/api/test-push` records
`trigger:"test"` ≠ `watch_detected`, so it cannot stand in — no-fallbacks, binding). The difference
from every prior pass: **the path is now real and tested** — before this fix, even a real watch
would not have fired.

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
