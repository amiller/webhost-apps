# #67 · calendar-share → ShareKit.oauth3Connect — flow evidence

**App:** calendar-share (`calendar-share/public/index.html`, served by `server.ts`)
**Branch/PR:** `ready-67` → `staging`
**Tier sought:** Tier 2 (walked flow). **Reached:** partial — see *What I could NOT verify*.
**Deployed staging tree:** `67a124949178` · `staging /calendar-share/ → 200` · `staging /oauth3/ → 200`
**Helper live on the page:** `typeof window.ShareKit.oauth3Connect === "function"` (share-kit v0.4.0 inlined)

## What changed (the migration)
- `onConnect` + `mintShare` now call `ShareKit.oauth3Connect` (extension path OR wallet
  self-provision). The app **no longer hand-rolls** `window.oauth3.connect` or the did:key
  wallet self-provision — ~60 lines removed (`walletKey`/`walletSignIn`/`connectViaWallet` +
  the b58/did:key crypto). `revokeShare` reuses the helper's persisted `oauth3_session`.
- `loadEvents` reads through `ShareKit.oauth3Read` and distinguishes a 409 step-up marker
  (actionable retry — **no raw `challenge_pending` dead-end**) from a terminal error (honest
  "read path not live yet" note). Connect stays pure-handshake (no probe): the google-calendar
  read isn't live (#69), and gating connect on it would regress the mint envelope.
- `share-kit` v0.4.0: `oauth3Connect` + `_connectViaWallet` forward `caps` so minting a
  `write:event:<id>` token uses the same shared handshake.
- `inline.sh` resolves the entry html at `<app>/index.html` OR `<app>/public/index.html`.
- `node --check` on the combined script: **OK**.

## Driven flow on staging (envoy bridge — real Brave, real fetches to the live node)
Bridge at `http://localhost:3000/api/bridge`; page `…/calendar-share/`. `window.oauth3` was
present (extension loaded).

**STEP A — extension path (natural, `window.oauth3` present):**
- helper → `onStatus("connecting", {via:"extension"})` → note rendered:
  `"Asking your wallet for a scoped token…"`; `connectWrap` stayed visible.
- This is the extension-mediated flow whose popup is browser chrome (not DOM-drivable) —
  expected, not a defect. The helper took the right branch.

**STEP B — wallet self-provision path (forced `window.oauth3 = undefined`, the path the
helper exists to support — fixes the #9 "install the extension" dead-end):**
- helper ran `_connectViaWallet`: did:key self-provision → `GET /api/login/challenge`
  (✅ returned a challenge) → Ed25519 sign → `POST /api/login` (✅ succeeded) →
  `POST /api/connect` → the node returned a **terminal** error.
- `onConnect`'s catch rendered it **verbatim**, with the node's own remedy, via `setNote`:
  > `App "calendar-share" is not listed. Add it via the operator or use dev-mode.`
- `connectWrap` stayed visible (Connect re-enabled) — honest, recoverable, **no dead-end, no mask**.

This demonstrates the **"errors render honestly"** acceptance criterion **live**: the real
node error reached the user unchanged, with an actionable next step.

### Independent corroboration (curl against the staging node, same calls the helper makes)
```
GET  /oauth3/api/login/challenge                 → 200, challenge cf4d3f66…        (login works)
POST /oauth3/api/connect  {"plugin":"google-calendar","app":"calendar-share"}
     → {"error":"App \"calendar-share\" is not listed. Add it via the operator or use dev-mode.","mode":"refuse"}
```
So the wallet handshake (the migrated code) runs end-to-end on staging up to the node's
app-listing gate; the gate is the only thing between this app and a successful connect.

## What I could NOT verify (honest — external blockers, not "out of ideas")
1. **`connect` success path** — BLOCKED on an **operator step**: calendar-share is not in the
   staging node's app allow-list (`mode:"refuse"`, "Add it via the operator"). Listing is
   operator-run (box-inventory: "not something this kit can grant"). The wallet login itself
   succeeds; only the listing gate stops the token. → **operator: list `calendar-share` on the
   staging oauth3 node, then this connect resolves to a real token.**
2. **Step screenshots** — the bridge `screenshot` tool is **broken at the rig level**:
   `{"success":false,"error":"timeout"}` on 8 attempts, including for `about:blank`
   (`navigate`/`evaluate` work fine). I did **not** commit a blank image. The flow above is a
   DOM transcript, not screenshots. → **operator: restore the envoy/neko screenshot path.**
3. **google-calendar read / step-up recovery** — N/A today: connect is gated (above) AND the
   read path returns "not yet captured" until oauth3-server#69 + the cube@ jar (per the app's
   own header). The step-up branch is code-present (`oauth3Read` marker → actionable retry,
   not a raw string) but not live-exercisable. It is the same shared, proven helper reddit-
   karma (#74) / timeline-peek / otterpilot (#61) already ship.

## Net
The #67 cleanup for calendar-share is implemented, deployed, and the shared connect handshake
runs on staging (extension branch + full wallet self-provision through login). Honest terminal-
error rendering is demonstrated live. Full Tier-2 (connect success + screenshots) waits on the
two operator steps above; this PR is therefore **`needs-e2e`**, not `ready-to-merge`.
