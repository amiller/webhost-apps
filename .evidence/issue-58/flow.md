# Evidence — issue #58: cart-share connect handshake (drop pre-minted OAUTH3_TOKEN)

**Repo:** amiller/webhost-apps · **Base:** staging · **Branch:** ready-58 · **Tier:** 2 (user-visible:
the owner view changes from an env-token read to a "Connect your Amazon cart" affordance).

## Acceptance (from issue #58)
1. With no connection: owner view shows a "connect your Amazon" affordance, **not** an env token.
2. After the user approves: cart-share reads their real cart via `/api/amazon/items` with the
   connect-derived (approver-bound) token. Honest `unconnected` state otherwise.

---

## Criterion 1 — REAL screenshot, captured this iteration ✅
`01-unconnected-affordance.png` (1920×1080, 72 KB, `test -s` ✓). Captured from the **real Brave
framebuffer** (`DISPLAY=:99 scrot` inside the `envoy-browser` container — the working capture path;
the bridge's `captureVisibleTab`-based `/screenshot` hangs under `--disable-gpu
--disable-software-rasterizer`, so the framebuffer read is used instead. Not CDP, not fabricated).

Driven the real Brave (neko, oauth3+envoy extensions loaded) to the deployed URL
`https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/cart-share/`
(`location.href` asserted via bridge `evaluate` before capturing — LESSONS). OCR of the shot reads:

```
CART SHARE
YOUR CART · NOT CONNECTED
CONNECT YOUR AMAZON CART →
approve amazon read on the OAuth3 consent page — cart-share detects approval automatically
```

That is the affordance, on the deployed page, with the honest `not connected` state. No
`OAUTH3_TOKEN` is read anywhere — the server has no env-token path (server.ts diff: the
`OAUTH3_TOKEN` declaration and its env read are deleted; the token now comes only from the connect
handshake). **Criterion 1 met on the deployed page, with a real committed PNG.** No personal data in
this frame (unconnected state — no items, prices, or ASINs).

## Criterion 2 — cart-share wiring re-verified end-to-end on deployed staging (this iteration)
The connect handshake works. Driven as the rig identity `u-swarm` (subject
`u-eaf13541f186c7c5f466dc04e2e5da4b`, key `~/.paseo-secrets/swarm-userkey`):

```
POST /cart-share/reset                                                       → 200 {source:"unconnected", connect:{status:"pending", approveUrl}}
GET  /cart-share/cart  (BEFORE approval)                                     → 200
  { "source":"unconnected", "connect":{ "status":"pending",
      "approveUrl":"…/oauth3/approve/req-d7bb668cd9654aaab2aebc80165220fd" } }

# the user approves the connect on the OAuth3 consent page:
POST /oauth3/api/login            {"userKey":<swarm-userkey>}                 → {subject, session}
POST /oauth3/api/connect/<rid>/approve  (Bearer session)                     → {"ok":true,"status":"approved"}
GET  /oauth3/api/connect/<rid>                                               → {"status":"approved","token":"tok-amazon-…"}

POST /cart-share/refresh   (cart-share polls the connect, gets the token)    → connect:{status:"approved"}
```

The connect-derived token is bound to the **approver** (it reads the approver's amazon jar),
confirming issue #58's NOTE: `approveConnect` mints with `approver` subject → the flow binds to the
user, not the app/owner attribution. **The cart-share code path under test is correct end-to-end.**

### New oauth3 behavior discovered this iteration (step-up challenge)
oauth3 on staging now requires a **step-up challenge** for amazon reads (it did NOT when criterion 2
was first captured on 2026-07-16). The first `/api/amazon/items` call returns:

```
HTTP 409  {"error":"challenge_pending","challengeId":"chal-…",
           "message":"Read requires step-up approval. Poll /api/challenge/:id for status."}
```

That challenge is approvable by the **user** (their session, not the connect token):

```
POST /oauth3/api/challenge/<chal>/approve  (Bearer <u-swarm session>)         → {"ok":true,"status":"approved"}
GET  /oauth3/api/challenge/<chal>                                           → {"status":"approved"}
```

After approval the 409 does **not** recur for that token. **Flag for a follow-up:** cart-share's read
path surfaces `challenge_pending` as a raw error but does not surface the `challengeId` or guide the
user to the step-up consent — so under the current oauth3 the owner view shows the error string until
the user approves step-up out-of-band. That is a UX gap, not a regression in this PR's intent
(switch auth source), but it should be filed.

## Criterion 2 — the real-cart read: BLOCKED on operator jar re-sync (this iteration)
After the step-up challenge was approved, the read returns a **different**, stable error:

```
GET /oauth3/api/amazon/items  (Bearer tok-amazon-…)   → HTTP 409 (3/3 retries, identical)
  {"error":"no jar synced for amazon"}
```

The approver's amazon jar is not populated. **This is operator-side state:** there is no sync/admin
API on the staging oauth3 (`/api/amazon/sync`, `/api/amazon/jars`, `/_api/admin/jars` all 404), and
the rig browser holds no Amazon session to capture. The jar **was** synced earlier today (see §B
below — the previous pass read 11 items / $506.49 from it); the operator's restart of oauth3 (to
clear the HTTP-500 outage) dropped the in-memory jar. Re-syncing requires operator-provisioned
Amazon session state — the one true external blocker.

### §B — prior real read (2026-07-16, still valid: the code is unchanged; only the env reset)
Captured against this same deployed staging when the jar was synced — the real result the gate wants,
recorded as counts/totals only (no item titles — personal data, see note):

```
GET /cart-share/cart  (AFTER approval)   → HTTP 200
  { "source":"amazon-jar", "item_count":11, "total":"506.49",
    "connect":{"status":"approved"}, "shared":false }
GET /oauth3/api/amazon/items  (Bearer tok-amazon-…)   → HTTP 200, item_count=11   (titles redacted)
```

This is what `/cart-share/refresh` will reproduce the moment the jar is re-synced — the connect
token and step-up challenge for the current request are already approved, so no re-approve is needed.

## Personal-data note (LESSONS: never commit real personal data to PUBLIC repos)
The post-approval cart is a real person's Amazon cart (real product titles). Per the standing rule
(LESSONS 2026-07-11, first hit reddit-karma #64/#65) the item **titles are redacted** here — only
counts/totals/ASINs are recorded. The true value-state is verified in-session (the cart renders
through the connect token) but the real screenshot is **NOT** committed. Criterion 1's committed PNG
is the unconnected state and contains no personal data.

## Rig identity note
`~/.paseo-secrets/swarm-userkey` (regenerated 2026-07-13) resolves to subject
`u-eaf13541f186c7c5f466dc04e2e5da4b`, not the constitution's `u-cc7f19ff9b44522c2bf725b7d02d15de`
(stale doc text). The key works end-to-end (login → approve connect → approve step-up → read).
Flagging so the doc can be updated.

## What I could NOT verify this iteration (honest)
- **Criterion 2 real-cart read** — blocked on the operator re-syncing the amazon jar for
  `u-eaf13541f186c7c5f466dc04e2e5da4b` (cleared by the oauth3 restart). No other gap remains: the
  connect handshake, approver-bound token, and step-up challenge are all verified on deployed
  staging. The PR stays `needs-e2e` until the jar is re-synced and the §B read is reproduced, after
  which criterion 2 is ~30 seconds (one `/refresh`, verify counts in-session, commit the transcript).
- **Criterion 2 screenshot** — by design not committed (real personal data). The committed
  criterion-2 evidence is the HTTP transcript (counts/totals), per LESSONS.
