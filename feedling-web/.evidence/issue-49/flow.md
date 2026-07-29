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

1. **`watch_detected` push delivery — operator-run (TRUE external blocker).** Firing
   `trigger=watch_detected sent>0` (the acceptance's alternative evidence) requires the
   operator's LIVE YouTube watch growing the history total AND a registered push subscription.
   On this box `shortCheck()` can't see any watch: the live page renders
   `⚠ App "feedling" is not listed. Add it via the operator or use dev-mode.` (the staging
   oauth3 connect path is unresolved until the operator approves feedling on their pod), and a
   worker cannot watch a video on the operator's behalf. This step is handed back to the
   operator on the now-live staging URL: approve feedling → enable push → watch one regular
   video → receive the "you watched something just now — N new item(s)" push (or see the
   `[push] trigger=watch_detected sent>0` server log). The decision logic that produces that
   line is unit-tested in §1 and is unchanged from the reviewed code path. **This is why
   `needs-e2e` stays ON** — the acceptance's push delivery is real but not worker-producible.

The feature is fully implemented (and already present on staging), parse-checked, unit-tested,
its verbose toggle verified live over HTTP, and its UI captured as a pixel screenshot this
pass. The single remaining gap is the operator's live watch→push delivery.
