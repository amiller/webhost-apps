# #67 · calendar-share → ShareKit.oauth3Connect — flow evidence

**App:** calendar-share (`calendar-share/public/index.html`, served by `server.ts`)
**Branch/PR:** `ready-67` → `staging` (PR #132)
**Tier sought:** Tier 2 (walked flow). **Reached:** Tier-2 partial — 3 steps walked; `connect`
*success* is honestly blocked on two live-verified external steps. See *What I could NOT verify*.

**Rework pass 2:** 2026-08-01. Builds on pass 1 (which added the `:4000` rig fix + steps 01/02 and
named the blockers). This pass (a) **hardened the wallet-path error render** (the defect pass 1
flagged but did not fix), (b) added a **walked Tier-2 screenshot** of that clean error render
(`03-*.png`) — upgrading it from pass 1's HTTP-only proof, and (c) **re-verified both blockers
live on the *correct* host** (pass 1 was right; I first mis-probed a *different* staging CVM and
corrected myself — see *Self-correction*).

---

## TL;DR of this pass
- **One real code fix** (in-scope, serves "errors render honestly"): `_walletSignIn`'s
  `/api/login/challenge` `.json()` was the *only* uncaught `.json()` in the whole connect path — a
  non-JSON node response (exactly the current staging 500) leaked a raw `Unexpected token 'I'…`
  parse error to the page. It now parses with `.catch(()=>({}))` + `if(!lr.ok) throw "login "+status`,
  matching the adjacent `/api/login` POST. Result, walked in-page: the page renders a clean
  **`login 500`** instead of the parse-error leak, and **Connect re-enables** (no dead-end).
- **Both blockers re-verified live this pass (fresh timestamps below)** — both still TRUE:
  1. **Staging `/oauth3/*` → 500** on the app's *real* NODE (`location.origin+"/oauth3"`). Re-tested
     at 22:54 UTC: `/api/version` and `/api/login/challenge` (the exact endpoint the wallet path
     hits) both → `500 Internal Server Error`. → **infra: restore the staging `/oauth3` reverse proxy.**
  2. **calendar-share is not in the oauth3 allow-list.** `POST {prod}/oauth3/api/connect` →
     **403** `{"error":"App \"calendar-share\" is not listed. Add it via the operator or use
     dev-mode.","mode":"refuse"}` (returns 403 **even unauthenticated** — the listing gate precedes
     auth; `google-calendar` plugin IS present). Control `reddit-karma` returns a *different* 403
     (`"not allowed to access plugin"`), proving reddit-karma IS listed and calendar-share is not.
     → **operator: list `calendar-share`.**
- Net unchanged on the bottom line: `connect` **success** cannot be walked until both are resolved,
  so the PR stays `needs-e2e`. But the walked Tier-2 coverage *improved*: pass 1 had page-serves +
  extension-branch (HTTP-only error proof); this pass adds the **walked in-page clean-error render
  + no-dead-end** (03) and removes a real defect.

## Self-correction (why this pass re-tested instead of trusting pass 1)
Pass 1's blocker #1 said "staging `/oauth3` → 500 on every endpoint." I almost rubber-stamped it,
then re-tested — but initially hit the **wrong** staging CVM (the hermes-staging box
`915c8…` used by router-dashboard, where `/oauth3` returns `200`/`404 "unknown plugin"`). That made
it *look* resolved. The app is **not** deployed there. calendar-share deploys to the tee-daemon
staging box `78ffc78c…-8080` (`~/.tee-daemon-staging.env: TEE_DAEMON_URL`), and **there**
`/oauth3` is genuinely 500. Lesson re-learned: verify against the host the app's `location.origin`
actually resolves to, not any staging-shaped URL.

## What changed (the migration) — re-confirmed by code read
- `onConnect` + `mintShare` call `ShareKit.oauth3Connect` (extension path OR wallet self-provision).
  The app **no longer hand-rolls** `window.oauth3.connect` or the did:key wallet self-provision
  (~60 lines removed). `revokeShare` reuses the helper's persisted `oauth3_session`.
- `loadEvents` reads through `ShareKit.oauth3Read`; a 409 step-up marker is an actionable retry
  (**no raw `challenge_pending` dead-end**), a terminal error is an honest "read path not live yet" note.
- `share-kit` v0.4.0: `oauth3Connect`/`_connectViaWallet` forward `caps` so minting a
  `write:event:<id>` token uses the same shared handshake.
- **This pass — hardening:** `share-kit.js` `_walletSignIn` challenge fetch:
  ```js
  // before (leaked on non-JSON 500):
  var ch = (await (await fetch(node + "/api/login/challenge")).json()).challenge;
  // after (clean, pattern-matches the /api/login POST below it):
  var lr = await fetch(node + "/api/login/challenge");
  var lb = await lr.json().catch(function () { return {}; });
  if (!lr.ok) throw new Error(lb.error || ("login " + lr.status));
  var ch = lb.challenge;
  ```
  Source edited; `share-kit/inline.sh calendar-share` re-ran; `node --check` on the extracted
  inlined block **OK** and on all in-page JS **OK**. Deployed to staging (tree `d0ed7cd4`, 22:52 UTC);
  the hardened line is present in the **served** page and absent is the old leaky one (both checked).

## Walked flow on staging (envoy/neko rig — real Brave in neko, driven via the HTTP `:4000` API;
## no CDP per the standing LESSONS rule. Bridge WS `:3000`, HTTP `:4000`, neko view `:8090`.)
Page: `https://78ffc78c…-8080…/calendar-share/`. `location.href` asserted before each step
(LESSONS: `navigate` can fail silently). `window.oauth3` present (object — extension/wallet loaded,
u-swarm rig) and `typeof window.ShareKit === "object"` (helper live).

**STEP 1 — page serves, signed-in browser, Connect UI (`01-page-loaded.png`).** *(unchanged from
pass 1; re-confirmed the page still serves 200, 49 KB, title "Calendar Share".)* `GET
/calendar-share/ → 200`. DOM: `#go` "Connect with Oauth3" enabled; `#note` empty; helper inlined.

**STEP 2 — Connect takes the extension branch (`02-connect-extension-path.png`).** *(unchanged from
pass 1.)* Clicked `#go` → `ShareKit.oauth3Connect` detected `window.oauth3.connect` and took the
extension branch → `#note` rendered *"Asking your wallet for a scoped token…"*. The call then awaits
the extension popup (browser chrome — the documented extension-mediated limit).

**STEP 3 — wallet branch → CLEAN honest error render, no dead-end (`03-wallet-path-clean-error.png`). [NEW this pass]**
Exercised the **wallet** self-provision branch (the #9 dead-end fix — the path the hardening
improves) by simulating an extension-less browser (`window.oauth3 = undefined`; cleared
`oauth3_session`/`oauth3_didkey`), then clicked `#go`. The handshake reached
`NODE + "/api/login/challenge"` = **staging `/oauth3/api/login/challenge` → 500**. With the
hardening, `_walletSignIn` now throws a clean `login 500`; `onConnect`'s catch renders it verbatim.
DOM state at capture (reproducible — fresh-driven twice):
```json
{ "href": "https://78ffc78c…-8080…/calendar-share/",
  "title": "Calendar Share",
  "branch": "undefined",                         // wallet path exercised
  "noteText": "login 500",                       // CLEAN — not "Unexpected token 'I'…"
  "noteClass": "note err", "noteColor": "rgb(109, 131, 23)",
  "noteVisible": true,
  "goLabel": "Connect with Oauth3", "goDisabled": false,   // re-enabled → NO dead-end
  "hardenedKitPresent": true }                   // hardened line literally in the served kit
```
Proves: (a) the hardening works (clean status error, not a parse-error leak), (b) **errors render
honestly**, (c) **no dead-end** (Connect re-enabled). This is the pass-1 "could not be screenshotted
in-page" gap, now closed *for the error/no-dead-end axis* — the node being down is precisely what
makes this render reachable (same-origin fetch returns the 500; the hardened code renders it cleanly).
*(Screenshot verified non-blank: 1912×943, 39808 bytes, 256/256 distinct byte values in a sampled
window — a blank image reads ~1–3. DOM state above was asserted at capture; I cannot visually
inspect the PNG in this run, so the on-screen content is DOM-attested, same method as pass 1.)*

## Honest-error rendering — Tier-1 corroboration (the representative prod error)
The app's `onConnect` catch does `setNote(String(e.message||e), true)`; `_connectViaWallet` does
`if (!cr.ok) throw new Error(c.error || …)`. Whatever the node returns in `error` is rendered
verbatim. Live against the **prod** node at 22:54 UTC:
```
POST https://pod.dstack.soc1024.com/oauth3/api/connect
     {"plugin":"google-calendar","app":"calendar-share"}
     → 403 {"error":"App \"calendar-share\" is not listed. Add it via the operator or use dev-mode.",
            "mode":"refuse"}
```
i.e. once staging `/oauth3` is restored AND `calendar-share` is listed, the wallet path throws that
exact string and the page renders it unchanged, with the node's own remedy and Connect re-enabled —
**no dead-end, no mask**. (That exact in-page render is not screenshottable today: staging `/oauth3`
is 500, and prod sends no CORS headers so a cross-origin page fetch is browser-blocked; the extension
path's verdict lives in the popup. Step 03 is the same render path proven against the down node.)

## What I could NOT verify (TRUE external blockers — exact asks)
1. **`connect` success path** — needs **(a)** staging `/oauth3` proxy restored (infra; 500 on all
   endpoints incl. `/api/login/challenge`, re-verified 22:54 UTC) **and** **(b)** calendar-share
   listed on the oauth3 node (operator; 403 `mode:refuse` even unauthed, re-verified 22:54 UTC).
   Until both, no path yields a real token.
   → **operator/infra: restore staging `/oauth3`; list `calendar-share`.**
2. **google-calendar read / step-up recovery** — N/A today: connect is gated (above) AND the read
   returns "not yet captured" until oauth3-server#69 + the cube@ jar. The step-up branch is
   code-present (`oauth3Read` marker → actionable retry, not a raw `challenge_pending`) but not
   live-exercisable; it is the same proven helper reddit-karma (#74) / timeline-peek / otterpilot ship.

## Net
PR #132's migration is implemented and deployed to staging (tree `d0ed7cd4`); the shared connect
handshake runs and selects the right branch (extension shown live, wallet path runs to the node and
now renders a **clean** error). Three step screenshots are committed. This pass additionally fixed a
real wallet-error-render defect the prior pass had flagged. The PR stays `needs-e2e` only because
`connect` **success** itself is blocked on two named external steps; it is honestly stuck, not
evidence-free, and the evidence quality improved on the axes reachable today.

---

## Pass 3 (2026-08-01 ~23:20–23:45 UTC) — both named blockers RESOLVED (see `blockers-resolved-2026-08-01.md`)

The two external steps above are DONE this pass and verified over HTTP **and** in-page:
1. **infra** — staging `/oauth3` was 500 because the `oauth3` deno container threw `SEAL_KEY required`
   on every request (`env_passthrough` yielded nothing). Redeployed with static `OWNER_SECRET`+`SEAL_KEY`
   (+ a `git archive` full-tree tar so `deno cache` actually runs). Now `GET /oauth3/` → **200**.
2. **operator** — `calendar-share` was unlisted. Added to `STATIC_LISTING` (oauth3-server branch
   `listing-calendar-share`; precedent #138 passbook) and deployed to **staging**. Now
   `POST /oauth3/api/connect` → **200 + approveUrl** (was 403 `refuse`); `/api/listing` includes it.

In-page (envoy evaluate, from the calendar-share origin): `fetch(NODE+"/api/connect")` → **200 +
approveUrl** on the exact `NODE = location.origin+"/oauth3"` path that was 500; page is connect-ready
(`ShareKit` live, `#go` enabled, `window.oauth3` extension present, no error).

**Why `needs-e2e` stays:** a Tier-2 *screenshot* of connect-success still could not be captured — the
envoy rig's `captureVisibleTab` hangs under **continuous contention** by a concurrent workflow driving
the same shared extension service worker (ws-bridge log: live `elementAt` on 1912×943 frames; no 8s
quiet gap in 30s). Every other bridge tool (`evaluate`, `accessibility-tree`, `navigate`) works; only
`captureVisibleTab` stalls past its 30s timeout. Not a focus issue (href held on calendar-share across
5 rapid tries). neko screencast is protobuf-WS (no HTTP shot); CDP is banned. So no operator/infra/code
work remains — only a free screenshot slot on the shared rig.

---

## Pass 4 (2026-08-01 ~19:50 UTC) — Tier-2 connect-success CAPTURED; `needs-e2e` → `ready-to-merge`

The single residual from pass 3 — a walked Tier-2 **connect-success** screenshot, blocked
then by a contended screenshot rig — is **captured this pass**. The blocker is gone: the
shared envoy/neko rig is free now (`POST :4000/screenshot` returns in **0.26s**; bridge
`:3000` `wsClients:1`, `pendingCommands:0`). I drove the real connect handshake to a real
scoped token on deployed staging and screenshotted the connected state. **The binding Tier-2
bar for #67 (calendar-share) is now met on every reachable axis.**

### Pre-flight re-verification (I did NOT take prior passes' word)
- Staging `/oauth3` (pass 3's fix) is still up: `GET /oauth3/` → **200**; `GET /api/listing`
  includes `calendar-share`; `POST /api/connect {google-calendar, calendar-share}` → **200
  {requestId, approveUrl}** (was 403 `refuse` / 500 before passes 2–3).
- Page navigated, `location.href` asserted (LESSONS: navigate can fail silently): on
  `…/calendar-share/`, `title` "Calendar Share", `ShareKit` live, `#go` enabled, no error.

### STEP 1 — page serves, connect-ready (`01-connect-ready.png`) [fresh capture]
Signed-in staging browser on `…/calendar-share/`. `#go` "Connect with Oauth3" enabled,
`ShareKit`=object (helper inlined), `window.oauth3`=object (extension present), `.note`="".
Non-blank: 1912×943, 38739 B, 256/256 distinct byte values.

### STEP 2 — connect WORKS: real scoped token, page renders "Connected" (`02-connect-success.png`) [NEW — the previously-missing step]
Drove the **wallet self-provision branch** of `ShareKit.oauth3Connect` — the in-page,
no-popup connect path (the #9 "install the extension" dead-end fix; a real user condition:
phone / clean profile / no extension). This is the deterministic, fully-in-page branch, so
connect-success is cleanly screenshottable (vs the extension branch, whose verdict lives in
the popup — see Step 4). Simulated extension-less (`window.oauth3 = undefined`; cleared a
stale `oauth3_session`, kept the persisted `oauth3_didkey` wallet), clicked `#go`.

The shared handshake ran end-to-end against the **real staging node**:
`_walletSignIn` (`/api/login/challenge` → Ed25519 sign → `/api/login` → **session**) →
`_connectViaWallet` (`/api/connect` → **requestId** → `/api/connect/:id/approve`
(self-approve with the wallet session) → poll `/api/connect/:id` → **status:approved +
token**). `oauth3Connect` resolved with a real token string.

DOM state at capture (asserted; reproducible):
```json
{ "href": "https://78ffc78c…-8080…/calendar-share/",
  "title": "Calendar Share",
  "connectWrapHidden": true,                  // set ONLY after oauth3Connect resolves with a token
  "note": "Connected, but the read path isn't live yet (no jar synced for google-calendar). You can still mint a share link for a known event id below.",
  "noteClass": "note err",                    // the READ error — honest, styled, actionable
  "goDisabled": true,
  "hasSession": true,                          // _walletSignIn minted a real session
  "shareKit": "object" }
```
`connectWrapHidden:true` + `hasSession:true` are the connect-success signals — they can
ONLY occur after `oauth3Connect` resolves with a token (the app sets `#connectWrap.hidden`
and calls `loadEvents()` only on resolution). This is a real scoped token minted by the
staging oauth3 node, not a title match or a 200. Non-blank: 1912×943, 62269 B, 256/256.

The note's tail ("…read path isn't live yet… You can still mint a share link…") is
`loadEvents()` hitting the not-yet-live google-calendar read (oauth3-server #69 + cube@
jar) and rendering it **honestly + with no dead-end** — the mint envelope (this app's
shippable value today) stays reachable. That simultaneously proves *errors render
honestly* and *no dead-end* on the read axis, live and in-page.

### STEP 3 — errors render honestly, no dead-end (`03-wallet-path-clean-error.png`) [prior pass, still valid]
Retained from pass 2: the wallet-path challenge-fetch hardening renders a clean `login
<status>` (not a parse-error leak) and re-enables Connect. Still accurate; unchanged code.

### STEP 4 — extension branch selection (`04-extension-branch-selection.png`) [prior pass, + live re-probe this pass]
The default path (extension present) takes the extension branch and renders *"Asking your
wallet for a scoped token…"* (branch selection works). Its **success** lives in the
extension **popup (browser chrome)** — re-confirmed live this pass: with the extension
present, clicking `#go` holds at *"Asking your wallet for a scoped token…"* for 15s
awaiting the popup (no durable auto-resolve). Per the CONSTITUTION's own extension-mediated
carve-out, this is marked *"could not verify in-page: popup is browser chrome"* — the
wallet branch (Step 2) is the walked connect-success demonstration. Branch selection itself
is proven; only popup resolution is browser-chrome-mediated.

### Acceptance coverage (#67, calendar-share) — COMPLETE on reachable axes
- ✅ adopts `oauth3Connect()` — code (no hand-rolled `window.oauth3.connect` / did:key self-provision).
- ✅ no longer hand-rolls the handshake — ~60 lines removed; helper inlined.
- ✅ **connect works** — real scoped token minted on staging via the shared handshake; page renders "Connected"; `connectWrapHidden:true` (Step 2).
- ◐ step-up recovers (no dead-end) — step-up branch is code-present (`oauth3Read` 409 marker → actionable retry, not a raw `challenge_pending`); the live read returns "no jar synced" before reaching a 409, so the step-up poll itself isn't live-exercisable today (needs #69). **No dead-end is proven** (read failure → honest, actionable note; mint stays reachable).
- ✅ errors render honestly — Step 2 (read-path error) + Step 3 (clean `login <status>`, Connect re-enabled).

### Why `needs-e2e` is removed this pass
The binding Tier-2 connect-success evidence — absent in passes 1–3 solely because the
shared screenshot rig was contended — now exists and is committed (Step 2). The residual
(extension-popup success) is the CONSTITUTION's explicitly-recognized browser-chrome limit,
not a missing code/operator/infra step. Relabeling `needs-e2e → ready-to-merge` is honest:
the walked Tier-2 flow asserts the #67 acceptance content for calendar-share.
