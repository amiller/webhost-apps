# #67 · calendar-share → ShareKit.oauth3Connect — flow evidence

**App:** calendar-share (`calendar-share/public/index.html`, served by `server.ts`)
**Branch/PR:** `ready-67` → `staging` (PR #132)
**Tier sought:** Tier 2 (walked flow). **Reached:** Tier-2 partial — see *What I could NOT verify*.
**Rework pass:** 2026-08-01. Corrects the prior pass's "screenshot rig broken" finding **and** adds two
real step screenshots; surfaces a **new** infra blocker (staging `/oauth3` proxy is down).

---

## TL;DR of this pass
- **The screenshot rig was never broken.** The prior pass called the WS-bridge port
  (`localhost:3000/api/bridge/screenshot`); the envoy **HTTP API** lives on **`:4000`**
  (`POST /screenshot` → `{success:true, result:{image}}`). `POST :4000/screenshot` returns a real
  PNG immediately. Two step screenshots are now committed: `01-page-loaded.png`, `02-connect-extension-path.png`.
- **Two TRUE external blockers remain** (both re-verified live this pass, not taken on trust):
  1. **Staging CVM `/oauth3/*` → 500 Internal Server Error** on every endpoint (the app's
     `NODE = location.origin + "/oauth3"` points here). The prior pass (07-28) saw this proxy up
     and returning prod's `mode:refuse`; today it is down. → **infra/operator: restore the staging
     `/oauth3` reverse proxy.**
  2. **calendar-share is not in the oauth3 allow-list.** `POST {prod}/oauth3/api/connect` →
     **403** `{"error":"App \"calendar-share\" is not listed. Add it via the operator or use
     dev-mode.","mode":"refuse"}` (returns 403 **even unauthenticated** — the listing gate precedes
     auth). The `google-calendar` plugin IS present. → **operator: list `calendar-share`.**
- Net: connect-success cannot be walked today until both are resolved. The shared handshake runs;
  honest-error rendering is proven over HTTP (curl, below). The PR stays `needs-e2e` — honestly
  stuck on the two named steps, not on the e2e capability (which now works).

## What changed (the migration) — unchanged from prior pass, re-confirmed by code read
- `onConnect` + `mintShare` call `ShareKit.oauth3Connect` (extension path OR wallet self-provision).
  The app **no longer hand-rolls** `window.oauth3.connect` or the did:key wallet self-provision
  (~60 lines removed). `revokeShare` reuses the helper's persisted `oauth3_session`.
- `loadEvents` reads through `ShareKit.oauth3Read`; a 409 step-up marker is an actionable retry
  (**no raw `challenge_pending` dead-end**), a terminal error is an honest "read path not live yet" note.
- `share-kit` v0.4.0: `oauth3Connect`/`_connectViaWallet` forward `caps` so minting a
  `write:event:<id>` token uses the same shared handshake.
- `node --check` on the combined script: **OK** (re-run this pass).

## Walked flow on staging (envoy/neko rig — real Brave in `envoy-browser`, real fetches)
Bridge WS on `:3000`, **HTTP API on `:4000`** (the port the prior pass missed), neko view on `:8090`.
Page: `…/calendar-share/`. `window.oauth3` was present (extension loaded) and
`typeof window.ShareKit === "object"` (helper live). `location.href` asserted before each step
(per LESSONS — `navigate` can fail silently).

**STEP 1 — page serves, signed-in browser, Connect UI (`01-page-loaded.png`).**
`GET /calendar-share/ → 200` (49 KB). DOM at capture: title "Calendar Share"; `#go`
"CONNECT WITH OAUTH3" enabled; `#note` empty; body "oauth3 · edit-on-behalf demo / CALENDAR SHARE
/ Mint a link that edits ONE event…". Proves: PR #132 code is deployed to staging, the helper is
inlined, and the connect surface renders. *(Screenshot verified non-blank: 1912×943, extrema
((83,255),(55,255),(16,255)); DOM state at capture matches the caption.)*

**STEP 2 — Connect takes the extension branch (`02-connect-extension-path.png`).**
Clicked `#go`. `onConnect` → `ShareKit.oauth3Connect({plugin:"google-calendar", app:"calendar-share",
node:NODE, onStatus})`. Helper detected `window.oauth3.connect` and took the **extension** branch →
`onStatus("connecting",{via:"extension"})` → `#note` rendered **"Asking your wallet for a scoped
token…"**, `#go` disabled. This is the migrated code selecting the correct branch and rendering the
connecting state in-page. The call then awaits the extension popup, which is **browser chrome**
(not DOM-drivable — the documented extension-mediated limit); in the unattended rig it holds at this
state (polled 30 s). *(Screenshot verified non-blank: 1912×943, extrema ((17,255),(17,255),(9,255));
DOM at capture: `#note` = "Asking your wallet for a scoped token…".)*

**STEP 3 — wallet self-provision path (the #9 dead-end fix): attempted, blocked by staging infra.**
Forced `window.oauth3 = undefined` to exercise the wallet path the helper exists to support. The
handshake reached `NODE + "/api/login/challenge"` = **staging `/oauth3/api/login/challenge` → 500
"Internal Server Error"** (`application/octet-stream`). `_walletSignIn`'s `.json()` then throws
`Unexpected token 'I', "Internal S"… is not valid JSON`, which `onConnect`'s catch renders (raw).
That leaked parse error is a **symptom of the down staging proxy**, not the code's intended
behavior — I did **not** commit it as acceptance evidence (it would misrepresent the feature).
When the node is up, the same code path renders the clean operator error (proven by curl below).

## Honest-error rendering — proven over HTTP (Tier-1 corroboration of the Tier-2 render path)
The app's `onConnect` catch does `setNote(String(e.message||e), true)`; `_connectViaWallet` does
`if (!cr.ok) throw new Error(c.error || …)`. So whatever the node returns in `error` is rendered
verbatim. Live against the **prod** node (the app's real home; calendar-share is not listed there):
```
POST https://pod.dstack.soc1024.com/oauth3/api/connect
     {"plugin":"google-calendar","app":"calendar-share"}
     → 403 {"error":"App \"calendar-share\" is not listed. Add it via the operator or use dev-mode.",
            "mode":"refuse"}
```
i.e. once staging `/oauth3` is restored (or the app listed), the wallet path throws that exact
string and the page renders it unchanged, with the node's own remedy and Connect re-enabled —
**no dead-end, no mask**. (Could not be screenshotted in-page today: staging `/oauth3` is 500, and
prod sends no CORS headers, so a cross-origin page fetch is browser-blocked. The extension path is
the natural route but its result lives in the popup, not the DOM.)

## What I could NOT verify (TRUE external blockers — exact asks)
1. **`connect` success path** — needs **(a)** staging `/oauth3` proxy restored (infra; currently
   500 on all endpoints) **and** **(b)** calendar-share listed on the oauth3 node (operator; 403
   `mode:refuse` even unauthed). Until both, no path yields a real token.
   → **operator/infra: restore staging `/oauth3`; list `calendar-share`.**
2. **google-calendar read / step-up recovery** — N/A today: connect is gated (above) AND the read
   returns "not yet captured" until oauth3-server#69 + the cube@ jar. The step-up branch is
   code-present (`oauth3Read` marker → actionable retry, not a raw `challenge_pending`) but not
   live-exercisable; it is the same proven helper reddit-karma (#74) / timeline-peek / otterpilot ship.

## Net
PR #132's migration is implemented and deployed to staging; the shared connect handshake runs and
selects the right branch (extension shown live, wallet path runs to the node). Two real step
screenshots are committed. The e2e **capability** is proven (rig works on `:4000`). The PR is
`needs-e2e` only because connect-success itself is blocked on two named external steps; it is
honestly stuck, not evidence-free.
