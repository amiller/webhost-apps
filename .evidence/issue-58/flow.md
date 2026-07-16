# Evidence — issue #58: cart-share connect handshake (drop pre-minted OAUTH3_TOKEN)

**Repo:** amiller/webhost-apps · **Base:** staging · **Branch:** ready-58 · **Tier:** 2 (user-visible:
the owner view changes from an env-token read to a "Connect your Amazon cart" affordance).

## Acceptance (from issue #58)
1. With no connection: owner view shows a "connect your Amazon" affordance, **not** an env token.
2. After the user approves: cart-share reads their real cart via `/api/amazon/items` with the
   connect-derived (approver-bound) token. Honest `unconnected` state otherwise.

## ⚠️ Evidence caveat — bridge SCREENSHOT tool is down (labeled `needs-e2e`)
The envoy/neko bridge's **navigate** and **evaluate** tools work, but its **screenshot** capture
times out on EVERY page (incl. `https://example.com/`), and `GET /health` reports `wsClients: 0`.
A `restart`/`newSession` also timed out; it did not recover across ~10 retries over several minutes.
So I could NOT capture the PNG step screenshots the Tier-2 gate wants. Per the worker spec
("Bridge down or unreachable: label the PR `needs-e2e` and say so — never claim visual verification
you didn't do"), this PR is labeled **needs-e2e**, NOT `ready-to-merge`.

What I DID verify, honestly, through the real browser + deployed staging:

## A. Real-browser DOM assertion (deployed staging, via bridge `evaluate`)
Drove the real Brave (neko, oauth3+envoy extensions loaded) to the deployed URL:
`https://<staging-cvm>/cart-share/`. After the page's `/cart` call created the connect request:
```
location.href = https://78ffc78c25e0c8a9e64bb3abe9932…-8080.dstack-pha-prod7.phala.network/cart-share/
DOM = {"title":"cart-share · oauth3",
       "btn":"Connect your Amazon cart →",          ← the affordance (criterion 1)
       "card":"your cart · not connected",          ← honest unconnected state
       "sub_has_you_approve":true,                  ← new copy ("…after you approve…")
       "approve_url_present":true}
```
No `OAUTH3_TOKEN` is read anywhere — the server has no env-token path (see server.ts diff: the
`OAUTH3_TOKEN` declaration and its env read are deleted; the token now comes only from the connect
handshake). **Criterion 1 met on the deployed page.**

## B. Deployed HTTP transcript (against staging CVM, this iteration)
```
POST /cart-share/reset                                                          → HTTP 200   (clean slate)

GET  /cart-share/cart  (BEFORE approval)                                        → HTTP 200
  { "source":"unconnected", "items":0,
    "connect":{ "status":"pending",
      "approveUrl":"…/oauth3/approve/req-dc31cbbbe6144b25a3abe9932eb79cd8" } }

# simulate the user approving on the OAuth3 consent page (same endpoint the approve page calls):
POST /oauth3/api/login            {"userKey":<swarm-userkey>}   → {subject, session}
POST /oauth3/api/connect/<rid>/approve  (Bearer session)        → {"ok":true,"status":"approved"}

GET  /cart-share/cart  (AFTER approval)                                         → HTTP 200  (11.6s incl. organic search)
  { "source":"amazon-jar", "item_count":11, "total":"506.49",
    "connect":{"status":"approved"}, "shared":false }

GET  /oauth3/api/amazon/items  (Bearer <connect token tok-amazon-…>)            → HTTP 200
  plugin=amazon · item_count=11   (item TITLES redacted — see Personal-data note)
```
The connect-derived token is bound to the **approver** (it reads the approver's amazon jar),
confirming issue #58's NOTE: `approveConnect` mints with `approver` subject → the flow binds to the
user, not the app/owner attribution. **Criterion 2 met on the deployed page.**

## C. Local end-to-end (localhost:3999, OAUTH3_BASE → staging oauth3)
Before approval → `source:unconnected`, `connect:{status:"pending",approveUrl}`. After approval →
`source:amazon-jar`, 11 items. `/health` → `{build:"v3", source:"amazon-jar", connect:{status:"approved"}}`.

## Personal-data note (LESSONS: never commit real personal data to PUBLIC repos)
The post-approval cart is a real person's Amazon cart (real product titles). Per the standing rule
(LESSONS 2026-07-11, first hit reddit-karma #64/#65) the item **titles are redacted** here — only
counts/totals/ASINs are recorded. The true value-state was verified in-session (the 11-item cart
renders through the connect token) but is NOT committed.

## Rig identity note
`~/.paseo-secrets/swarm-userkey` (regenerated 2026-07-13) resolves to subject
`u-eaf13541f186c7c5f466dc04e2e5da4b`, not the constitution's `u-cc7f19ff9b44522c2bf725b7d02d15de`
(stale doc text). The key works end-to-end (login → approve → read). Flagging so the doc can be
updated.

## What I could NOT verify this iteration
- **Screenshot artifacts** — bridge screenshot capture is down (see caveat). The PR is `needs-e2e`.
  Re-run `bridge screenshot` on the deployed `/cart-share/` page once the capture extension
  reconnects to produce the Tier-2 PNGs.
- **Real UI post** is N/A for cart-share (it's a cart read, not a write).
