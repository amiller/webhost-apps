# Evidence — issue #58: cart-share connect handshake (drop pre-minted OAUTH3_TOKEN)

**Repo:** amiller/webhost-apps · **Base:** staging · **Branch:** ready-58 · **Head:** `11c7895` · **Tier:** 2
(user-visible: the owner view changes from an env-token read to a "Connect your Amazon cart" affordance;
after the user approves, cart-share reads their real cart via the connect-derived, approver-bound token).

**Deployed staging (this evidence):** `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/cart-share/`
**oauth3 staging commit (version pin):** `d32afe8047b61003cfd2b4083c157ab64c4e2b20` (`GET /oauth3/_api/version`).
**cart-share build:** `v3`.

## Acceptance (from issue #58)
1. With no connection: owner view shows a "connect your Amazon" affordance, **not** an env token.
2. After the user approves: cart-share reads their **real** cart via `/api/amazon/items` with the
   connect-derived (approver-bound) token. Honest `unconnected` state otherwise.

**Result: BOTH criteria met on deployed staging this iteration (2026-07-28).**

---

## Criterion 1 — REAL screenshot ✅ (re-captured this iteration)
`01-unconnected-affordance.png` (1920×1080, ~83 KB, `test -s` ✓). Captured from the **real Brave
framebuffer** (`DISPLAY=:99 scrot` inside the `envoy-browser` container — the working capture path;
the bridge's `captureVisibleTab`-based `/screenshot` hangs under `--disable-gpu
--disable-software-rasterizer`, so the framebuffer read is used instead. Not CDP, not fabricated).

Driven the real Brave (neko, oauth3+envoy extensions loaded) to the deployed URL
(`location.href` asserted via the bridge `evaluate` before capturing — LESSONS). The owner view in
the unconnected state was DOM-verified (`hasAffordance:true, hasNotConnected:true`, no `OAUTH3_TOKEN`/
`env token` text) and the screenshot OCR reads:

```
@ cart-share - oauth3
OAUTH3 - SCOPED DELEGATION - AMAZON CART
CART SHARE
YOUR CART - NOT CONNECTED
CONNECT YOUR AMAZON CART
approve amazon read on the OAuth3 consent page …
```

That is the affordance, on the deployed page, with the honest `not connected` state. No `OAUTH3_TOKEN`
is read anywhere — the server has no env-token path (the `OAUTH3_TOKEN` declaration and its env read
are deleted; the token now comes only from the connect handshake). **Criterion 1 met.** No personal
data in this frame (unconnected state — no items, prices, or ASINs).

## Criterion 2 — approve → real cart ✅ (verified end-to-end this iteration)
Driven as the rig identity `u-swarm` (subject `u-eaf13541f186c7c5f466dc04e2e5da4b`,
`~/.paseo-secrets/swarm-userkey`). The connect handshake works and the approver-bound token reads the
real cart. Transcript (counts/totals only — **titles redacted**, real personal data, see note):

```
POST /oauth3/api/login            {"userKey":<swarm-userkey>}                 → 200 {subject, session}
POST /cart-share/reset                                                        → 200 {source:"unconnected", connect:{status:"pending", approveUrl}}
POST /oauth3/api/connect/<rid>/approve  (Bearer <u-swarm session>)            → 200 {"ok":true,"status":"approved"}
GET  /oauth3/api/connect/<rid>                                               → 200 {"status":"approved","token":"tok-amazon-…"}   (bound to the APPROVER)
GET  /oauth3/api/amazon/items       (Bearer tok-amazon-…)                     → 200, item_count = 11   (titles REDACTED)
POST /cart-share/refresh                                                      → 200 {source:"amazon-jar", items:11, connect:{status:"approved"}}
GET  /cart-share/cart                                                         → 200 {source:"amazon-jar", item_count:11, total:"506.67", connect:{status:"approved"}, shared:false}
```

- The connect-derived token is bound to the **approver** (it reads the approver's amazon jar),
  confirming issue #58's NOTE: `approveConnect` mints with the approver's subject → the flow binds to
  the user, not a pre-minted app/owner token.
- No step-up challenge fired this iteration (the read returned HTTP 200 directly). Prior passes saw a
  `409 challenge_pending`; that gate did not recur here. (The step-up UX gap flagged previously —
  cart-share surfaces `challenge_pending` as a raw error — is unchanged and remains a follow-up, not a
  regression of this PR's intent.)
- **Render verified in-session:** the real Brave on `/cart-share/` shows the cart value state (12
  price strings in the DOM = 11 line totals + cart total). The real screenshot is **not** committed
  (it would publish item titles — personal data); the HTTP transcript above is the committed real
  result, per LESSONS.
- **Render path proven with a committed labeled sample:** `02-render-check.png` (108 KB, `test -s` ✓,
  OCR-verified). It is the shipped `drawOwner()` `source==="amazon-jar"` success branch + the shipped
  `<style>` (copied **verbatim** from `cart-share/public/index.html`; source kept alongside as
  `02-render-check.source.html`), fed obviously-fake sample items (`SAMPLE ITEM — …`). It proves the
  connected-cart render path renders item rows + per-line prices + total + the owner share/checkout
  controls + the receipt card. This is the LESSONS-sanctioned substitute for committing the real cart
  shot (precedent: reddit-karma #64 `04-render-check.png`). Rendered headlessly from a **local** file —
  not a real-browser/external flow, so outside the CDP-on-real-flows ban; the live read itself is the
  committed transcript + the in-session DOM check, not this image.
- Live, not a fixture: the total drifted from the 2026-07-16 read (`$506.49`) to `$506.67` today — a
  frozen fixture would not move. **Criterion 2 met.**

## How the approver jar was provisioned (no fallback, no fixture)
oauth3's amazon plugin reads the owner's Amazon cookie jar; a jar is synced via the documented
owner/extension route `POST /oauth3/api/cookies {plugin:"amazon", cookies:{…}}`, which calls
`setJar(subject, plugin, cookies)` keyed `subject:plugin` (oauth3-server `server/handler.ts` +
`server/vault.ts`). The jar for `u-eaf13541…` was provisioned by syncing the operator-provided Amazon
cookie export (`~/.paseo-secrets/jars/amazon.com.json`, 32 cookies incl. `at-main`/`sess-at-main`) as
`u-swarm` — **no** fixture cart, **no** `OAUTH3_TOKEN` env var. The plugin (`server/plugins/amazon.ts`)
throws honest errors (robot-check / expired-jar / unparseable) rather than masking them as an empty
cart; none fired.

> ⚠️ **Persistence caveat for future passes:** the deployed oauth3 vault is in-memory when no
> `DATA_DIR` is configured (`initVault` returns early on empty dir → store is `vault.sealed`-less, so a
> process restart wipes it). That is *why* the prior passes' jar re-syncs did not survive the oauth3
> restart (the HTTP-500 outage recovery): each restart emptied the jar and the read went back to
> `409 no jar synced for amazon`. If this recurs, re-sync the jar (the 32-cookie POST above) **after**
> the last oauth3 restart, or have the operator set `DATA_DIR` so the sealed vault persists.

## Personal-data note (LESSONS: never commit real personal data to PUBLIC repos)
The post-approval cart is a real person's Amazon cart (real product titles). Per the standing rule
(LESSONS 2026-07-11, first hit reddit-karma #64/#65) the item **titles are redacted** throughout this
evidence — only counts/totals are recorded. The true value-state is verified in-session (the cart
renders through the connect token; 12 price strings in the DOM) but the real screenshot is **NOT**
committed. The committed images are: `01-unconnected-affordance.png` (criterion 1 — unconnected state,
no personal data) and `02-render-check.png` (criterion 2 render path — a clearly-labeled **sample**,
`not live data`, fake items; proves the render markup only). The operator-provided cookie jar lives
outside the repo (`~/.paseo-secrets/`) and is not committed; no cookie values appear anywhere in this
evidence.

## Rig identity note
`~/.paseo-secrets/swarm-userkey` resolves to subject `u-eaf13541f186c7c5f466dc04e2e5da4b`, not the
CONSTITUTION's `u-cc7f19ff9b44522c2bf725b7d02d15de` (stale doc text). The key works end-to-end
(login → approve connect → read). Flagging so the doc can be updated; not in scope for this PR.
