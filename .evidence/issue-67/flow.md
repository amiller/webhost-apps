# Flow evidence — issue #67 (reddit-karma → shared oauth3Connect)

**Tier:** 2 (user-visible) — **functional proof captured; rendered screenshot externally blocked → PR labeled `needs-e2e`** (the spec-sanctioned label when the envoy bridge can't capture; same as PR #63). The acceptance content IS asserted below via the bridge.

## What changed (one PR, root-cause)
`ShareKit.oauth3Connect` (share-kit v0.2.0 → **v0.3.0**) gained the **no-extension wallet
self-provision path** (did:key → `/api/login` → `/api/connect` → `/approve` → poll) — ported
verbatim from reddit-karma's proven boilerplate. It runs when `window.oauth3.connect` is absent,
**instead of dead-ending on "install the oauth3 extension"** (the #9 regression). reddit-karma now
routes both connect AND the read through the helper (`ShareKit.oauth3Connect` + `ShareKit.oauth3Read`),
so a step-up recovers automatically and every real failure renders honestly. ~60 lines of duplicated
wallet/base58 boilerplate deleted from reddit-karma.

## Acceptance (#67, for reddit-karma) — asserted
> "reddit-karma adopts `oauth3Connect()` and no longer hand-rolls the handshake… connect works,
> step-up recovers (no dead-end), errors render honestly."

- ✅ No longer hand-rolls: grep of the app script → **0** `walletKey`/`connectViaWallet`/`b58e`/`b64uDec`
  defs; **5** `ShareKit.oauth3Connect`/`oauth3Read` uses. Boilerplate block replaced by a pointer comment.
- ✅ Connect works via the helper, **including the no-extension wallet path** (proven below) — the old
  dead-end string is gone from the served page.
- ✅ No dead-end / errors render honestly (proven below — the real node 403 rides into the evidence block).

## Functional verification — deployed to staging, driven via the envoy bridge
Deploy: `bash scripts/deploy-static.sh reddit-karma --ref HEAD` → tree `9c1d0eefff97` live at
`<staging>/reddit-karma/`. Served build markers confirmed: `BUILD = "b4"`, `share-kit … (v0.3.0)`,
`_connectViaWallet`, `via: "wallet"`.

The envoy browser carries the oauth3 extension (which re-injects `window.oauth3`), so to exercise the
**no-extension** branch I pinned `window.oauth3` to a non-`connect` stub via `Object.defineProperty`
(getter + no-op setter), cleared wallet storage, and clicked Connect. Bridge `navigate`/`evaluate` only
— `screenshot` times out (see blocker). `flock /tmp/envoy-bridge.lock` serialized every call.

After click (wallet branch ran):
```
pathname      /reddit-karma/                         (page stable, no extension navigation)
oauth3connect "undefined"                            (stub held → helper took the WALLET branch)
oauth3_didkey {"alg":"Ed25519","crv":"Ed25519","d":"fE…   (self-provisioned Ed25519 key, stored)
session       sess-ed70667…                          (REAL session from POST /api/login — login succeeded)
note          "Connect or read failed — see evidence for the real error."
evidence      source: error
              endpoint: GET …/oauth3/api/reddit/items
              reason:  App "reddit-karma" is not listed. Add it via the operator or use dev-mode.
deadend       false   (no "install the oauth3 extension" text anywhere on the page)
```
→ The wallet self-provision ran (did:key + real session), the connect hit the node's layer-1 listing
gate (403), and the app rendered the **honest error** with the node's real message — **no dead-end, no mask**.

### The ported wallet code reaches a token end-to-end (node HTTP transcript, listed `demo-app` appId)
reddit-karma's own appId isn't in the node's `STATIC_LISTING` (operator config), so its connect 403s.
To prove the wallet code path I ported gets all the way to a token + read, the identical flow against
the listed `demo-app`:
```
did          did:key:z6Mkfxx4…
POST /api/login            200  session ✓
POST /api/connect          200  requestId req-160f789a…
POST /api/connect/<id>/approve  200  ok
poll /api/connect/<id>     → token tok-reddit-49f…
GET  /api/reddit/items     409  {"error":"no jar synced for reddit"}   (honest — no reddit jar synced)
```
So the ported handshake is correct end-to-end; only operator-side config (app listing + reddit jar)
stands between this and a green feed.

## Parse
- `node --check share-kit/share-kit.js` → PARSE_OK (503-line inlined copy in reddit-karma also PARSE_OK).
- `node --check` on reddit-karma's app `<script>` → PARSE_OK (132 lines).

## ⚠️ Could NOT capture — TRUE external blocker (rendered screenshot)
The envoy bridge `screenshot` tool times out (3/3 + a retry): the operator's active research job
`oram-research/build_dataset.py` (PID 3315077, `flock ~/.dataset.lock`, driving the single shared envoy
browser at eprint.iacr.org) saturates the envoy extension. **Not killed** — it's the operator's job.
No alternate capture on this box (envoy container has no scrot/import/xwd/ffmpeg; neko `/api/screenshot`
404; browser-box is CDP, banned by LESSONS). Per spec → `needs-e2e`; I do not claim a screenshot I
didn't capture.

## Operator steps to flip this to full Tier-2 green
1. **List the app** on the staging node: add `reddit-karma` to `STATIC_LISTING` in
   `oauth3-server/server/listing.ts` (allow `reddit`, scope `read`) — or test via `demo-app`.
2. **Sync a reddit jar** for the rig subject (`POST /oauth3/api/cookies`, plugin `reddit`,
   `reddit_session` cookie) so `/api/reddit/items` returns real saved posts.
3. With `build_dataset.py` not running (or a second envoy profile), open `<staging>/reddit-karma/`
   with the extension disabled/pinned-out, click Connect, screenshot the saved-posts card.

## Note on the broader #67 arc
This helper enhancement also removes the no-extension dead-end for **every** adopter (timeline-peek's
#9 regression, otterpilot, calendar-share) — but those apps are NOT touched here (one PR per app per
#67; timeline-peek has open PR #63 on it). Re-running `share-kit/inline.sh <app>` on each picks up
v0.3.0 + the wallet path without hand-merging.
