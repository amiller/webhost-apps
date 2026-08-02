# Flow evidence — issue #67 (reddit-karma → shared oauth3Connect)

**Tier:** 2 (user-visible) — **walked flow captured 2026-07-27** (3 step screenshots + this file).
The earlier `needs-e2e` blocker (envoy bridge `screenshot` timing out) is **resolved** — see
"Tier-2 walked flow" below. Functional/HTTP proof from the prior pass is retained underneath.

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

- ✅ **Adopts the helper, no hand-roll** — `01-landing.png`: page loads `ShareKit.VERSION = "0.3.0"`,
  Connect button present; grep of the app script → **0** `walletKey`/`connectViaWallet`/`b58e`/`b64uDec`
  defs, **5** `ShareKit.oauth3Connect`/`oauth3Read` uses (boilerplate replaced by a pointer comment).
- ✅ **No dead-end (no-extension wallet path)** — `02-no-extension-branch.png`: with `window.oauth3`
  neutralized (faithful phone/clean-profile sim), the diag line reads "extension **absent — Connect
  will self-provision a wallet**"; the old "install the oauth3 extension" dead-end string is absent.
- ✅ **Connect works (real token) + errors render honestly** — `03-connect-result.png`: after clicking
  Connect the wallet path self-provisioned a did:key, ran the full handshake, and obtained a **real
  scoped token `tok-reddit-7…`**; the read returned `409 "no jar synced for reddit"`, which the app
  renders as a plain error card ("No saved posts to show", "no posts are shown, never fake content")
  with the real `status 409` + `token` + `reason` in the evidence block. No mask, no fixture.

## Tier-2 walked flow — captured 2026-07-27 (blocker cleared)
**Deploy pin.** `bash scripts/deploy-static.sh reddit-karma --ref origin/ready-67` → tree
`9c1d0eefff97` live at `https://78ffc78c…dstack-pha-prod7.phala.network/reddit-karma/`.
The served `index.html` is **byte-identical** to `origin/ready-67:reddit-karma/index.html` (verified
by `diff` of the live fetch vs the branch). Served markers: `BUILD = "b4"`, `share-kit … (v0.3.0)`.
(`/_api/version` currently 500s — a pre-existing daemon quirk, unrelated to this static app; the
deploy is anchored on the static-app tree hash above, which is the correct pin for a Tier-2 walk.)

**Blocker resolution.** The earlier `needs-e2e` was double-blocked: (a) the operator's
`oram-research/build_dataset.py` (PID 3315077) saturating the shared envoy browser — **no longer
running** (gone, no holder on `~/.dataset.lock`); and (b) a deeper envoy-bridge `screenshot` failure
returning `"Failed to capture tab: image readback failed"` (a Chromium compositor/GPU readback crash
in the neko container, not saturation). A `docker restart envoy-browser` reset the compositor; the
bridge `screenshot` tool then returned a valid base64 PNG in ~0.15s. `navigate`/`evaluate`/`screenshot`
all used through the sanctioned envoy bridge (no CDP — LESSONS ban honored). `flock
/tmp/envoy-bridge.lock` serialized every call; bridge logs confirm this was the sole driver during the
walk (the operator's `oram-research/scholar-kit` playwright chromium is a *separate* browser).

**Walk (driven via `bash /tmp/bridge.sh <tool>`, location.href asserted before every trust):**
```
navigate  https://78ffc78c…dstack-pha-prod7.phala.network/reddit-karma/
assert    location.href == …/reddit-karma/  · readyState=complete · title="Reddit Saved"   → 01-landing.png
            ShareKit.VERSION="0.3.0" · #go present · diag: build b4 · instance reachable · reddit plugin registered
lock      Object.defineProperty(window,'oauth3',{value:undefined,writable:false,configurable:false})
            (faithful no-extension / phone / clean-profile sim; the in-browser extension otherwise
             re-injects window.oauth3 via its tight loop. The wallet code still makes REAL calls to the node.)
diag      "extension absent — Connect will self-provision a wallet"  (stable at 0s/2s/5s)      → 02-no-extension-branch.png
click     #go  (real pointer event via bridge /click)
wallet    did:key self-provision → POST /api/login (session) → POST /api/connect → /approve → poll
result    token tok-reddit-7… (REAL scoped token — the full wallet handshake reached a token for
            reddit-karma itself, stronger than the prior demo-app substitute; reddit-karma is now
            accepted by the live node)
read      GET /api/reddit/items (Bearer tok-reddit-7…) → 409 {"error":"no jar synced for reddit"}
render    renderError → "No saved posts to show" · stamp=error · evidence block:
            source=error · status=409 · token=tok-reddit-7… · reason="no jar synced for reddit"   → 03-connect-result.png
deadend   false — the string "install the oauth3 extension" appears nowhere on the rendered page
```

**Why the screenshot shows an error, and why that is the correct Tier-2 evidence.** reddit-karma is
listed on the live node (the prior 403 listing gate is gone), so the wallet handshake now reaches a
real token; the read 409s only because **no reddit data jar is synced for the rig subject** (an
operator-side data step, not a code defect). Per the no-fallbacks rule the app renders that honestly
(no fake posts) — which is exactly the acceptance criterion "errors render honestly". A green saved-
posts card would additionally require the operator to sync a reddit jar (see operator steps below);
that is out of scope for this code PR.

**Data privacy.** No personal reddit data is rendered (the card explicitly shows zero posts). The
token is shown truncated (`tok-reddit-7…`); the reason is a generic plugin message. Nothing in the
three screenshots is the operator's personal data, so they are safe in this public repo (LESSONS:
never commit real personal data).

### (Retained) functional verification — envoy bridge, prior pass
Deploy: `bash scripts/deploy-static.sh reddit-karma --ref HEAD` → tree `9c1d0eefff97`. Served build
markers confirmed: `BUILD = "b4"`, `share-kit … (v0.3.0)`, `_connectViaWallet`, `via: "wallet"`.

The envoy browser carries the oauth3 extension (which re-injects `window.oauth3`), so to exercise the
**no-extension** branch `window.oauth3` was pinned to a non-`connect` stub and Connect clicked. After
click (wallet branch ran):
```
session       sess-ed70667…                          (REAL session from POST /api/login — login succeeded)
evidence      source: error · endpoint: GET …/oauth3/api/reddit/items
              reason:  App "reddit-karma" is not listed. Add it via the operator or use dev-mode.
deadend       false   (no "install the oauth3 extension" text anywhere on the page)
```
(The prior pass hit the layer-1 listing 403; the 2026-07-27 walk above shows the node now lists
reddit-karma, so the same wallet path reaches a real token + the downstream 409.)

### The ported wallet code reaches a token end-to-end (node HTTP transcript, listed `demo-app` appId)
reddit-karma's own appId wasn't in the node's `STATIC_LISTING` at the time of the prior pass, so to
prove the wallet code path gets all the way to a token + read, the identical flow against the listed
`demo-app`:
```
did          did:key:z6Mkfxx4…
POST /api/login            200  session ✓
POST /api/connect          200  requestId req-160f789a…
POST /api/connect/<id>/approve  200  ok
poll /api/connect/<id>     → token tok-reddit-49f…
GET  /api/reddit/items     409  {"error":"no jar synced for reddit"}   (honest — no reddit jar synced)
```

## Parse
- `node --check share-kit/share-kit.js` → PARSE_OK (503-line inlined copy in reddit-karma also PARSE_OK).
- `node --check` on reddit-karma's app `<script>` → PARSE_OK (132 lines).

## ✅ Could NOT capture — RESOLVED (2026-07-27)
The earlier `needs-e2e` blocker is cleared: `build_dataset.py` is no longer running, and the
envoy-bridge `screenshot` "image readback failed" crash was fixed by restarting `envoy-browser`.
Three step screenshots are committed (`01/02/03-*.png`) and embedded in the PR body. No blank images;
each PNG is a valid non-blank capture (1912×943, 256 distinct byte values) and its caption is grounded
in the DOM state asserted via bridge `evaluate` at capture time (the worker cannot visually inspect
images, so the visible content is substantiated by the asserted DOM text + the verified PNG).

## Operator steps to additionally see a green saved-posts card (out of scope for this code PR)
1. **Sync a reddit jar** for the rig subject (`POST /oauth3/api/cookies`, plugin `reddit`,
   `reddit_session` cookie) so `/api/reddit/items` returns real saved posts. (Listing is no longer
   blocking — the wallet path already reaches a token for reddit-karma.)
2. With a jar synced, open `<staging>/reddit-karma/`, click Connect, and the saved-posts card renders
   `live` — keep that screenshot out of the public repo (real personal data).

## Note on the broader #67 arc
This helper enhancement also removes the no-extension dead-end for **every** adopter (timeline-peek's
#9 regression, otterpilot, calendar-share) — but those apps are NOT touched here (one PR per app per
#67; timeline-peek has open PR #63 on it). Re-running `share-kit/inline.sh <app>` on each picks up
v0.3.0 + the wallet path without hand-merging.


---

# #67 · calendar-share → ShareKit.oauth3Connect — acceptance assertion (PR #132)

> This section is the **calendar-share** app of issue #67 (a multi-app umbrella; the reddit-karma
> record above is from merged PR #74 and is left untouched). It is appended so the canonical
> `.evidence/issue-67/flow.md` rolls up every app's acceptance in one place, per the CONSTITUTION
> Tier-2 layout (`.evidence/issue-<N>/flow.md`). The full pass-by-pass record + the four step
> screenshots live in `.evidence/issue-67/calendar-share/`.

**Acceptance (#67, for calendar-share):** *adopts `oauth3Connect()` and no longer hand-rolls the
handshake; connect works; step-up recovers (no dead-end); errors render honestly.* — **asserted:**

- ✅ **Adopts the helper, no hand-roll** — `calendar-share/public/index.html` routes connect + mint
  through `ShareKit.oauth3Connect`; the hand-rolled `window.oauth3.connect` and the did:key wallet
  self-provision were deleted (~60 lines). `caps` is forwarded, so minting a `write:event:<id>` token
  uses the same shared handshake.
- ✅ **Connect works (real token)** — `calendar-share/02-connect-success.png`: drove the **wallet
  self-provision branch** of `oauth3Connect` on deployed staging to a **real scoped token** minted by
  the staging node (`_walletSignIn` → challenge → Ed25519 sign → `/api/login` → session →
  `/api/connect` → `/approve` → poll → token). DOM at capture: `connectWrapHidden:true` (set only
  after `oauth3Connect` resolves with a token) + `hasSession:true`; page reads "Connected…".
- ✅ **Errors render honestly** — `calendar-share/03-wallet-path-clean-error.png`: the wallet-path
  `/api/login/challenge` `.json()` now `.catch(()=>({}))` → clean `login <status>` (was a raw
  `Unexpected token…` parse leak); the not-yet-live read path (#69) renders an honest actionable note
  and Connect re-enables. `01-connect-ready.png`: page serves, `#go` enabled, `ShareKit` live, no error.
- ◐ **Step-up / no dead-end** — code-present as an actionable retry (`oauth3Read` 409 marker, not a
  raw `challenge_pending`); the live 409 step-up is not exercisable today (the read returns
  "no jar synced" before reaching a 409, needs #69). **No dead-end is proven** — read failure renders
  an honest, actionable note and the mint envelope stays reachable.
- ◐ **Extension branch** — branch *selection* is proven
  (`calendar-share/04-extension-branch-selection.png`); connect-*success* via the extension popup is
  browser chrome (CONSTITUTION carve-out) — marked *"could not verify in-page: popup is browser
  chrome"*. The **wallet self-provision branch** above is the walked connect-success (a real user
  condition and the #9 fix code path).

**Detailed record:** `.evidence/issue-67/calendar-share/flow.md` (passes 1–4) +
`calendar-share/blockers-resolved-2026-08-01.md`. All four PNGs `test -s` non-blank (38–63 KB, 256
distinct byte values). Driven via the envoy/neko HTTP rig (`:4000`, real Brave in neko, **no CDP** per
the standing LESSONS rule); `location.href` asserted before each capture.

**Staging listing / node** (the two external blockers passes 1–2 named, resolved in pass 3):
`POST /oauth3/api/connect {google-calendar, calendar-share}` → `200 {requestId, approveUrl}` (was
403 "not listed"); `/oauth3/api/listing` includes `calendar-share`; staging `/oauth3/*` → 200 (was 500).
