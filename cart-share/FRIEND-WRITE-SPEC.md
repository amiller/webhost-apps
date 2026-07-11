# cart-share: make the friend actually substitute an item in the REAL Amazon cart

**Status: the friend-substitution flow is currently a MOCK and must be built for real.**
This spec is the source of truth for the overnight work. Do NOT mark any item done on a mock —
every acceptance check below requires an end-to-end demonstration against a real logged-in
Amazon cart (subject `u-b3c12b16a7139ad98af14f48af3570c1`, whose jar is synced in the vault).

## Honest current state (2026-07-11)

| Piece | State |
|---|---|
| Owner reads their real cart (`amazon` plugin `/gp/cart/view.html` raw fetch, jar from vault) | ✅ real, works |
| Saved-for-later excluded (cut at `#sc-saved-cart-container`) | ✅ real, works |
| Owner connects tokenlessly via extension (`window.oauth3.connect`), step-up not double-gated | ✅ real, works |
| Friend "capability" token | ❌ FAKE — cart-share mints a local `cap-<uuid>` (`server.ts` `tok()`), not an oauth3 token |
| Friend "substitute" | ❌ MOCK — `POST /friend/substitute` mutates cart-share's in-memory `cart[]` only |
| `amazon` plugin write/mutate | ❌ DOES NOT EXIST — plugin is read-only (`listItems`/`fetchItem`; see comment at `amazon.ts:5`) |

## Target flow (what "acceptable" means)

1. Owner connects (already works) → sees their real cart.
2. Owner clicks **Invite a friend** → cart-share asks the oauth3 core to mint a **real, scoped,
   attenuated, revocable** delegation token carrying capability `amazon:cart-substitute` (bound to
   the owner's subject, NOT the fake `cap-`). The `?cap=<token>` link carries THIS token.
3. Friend opens the link → friend view lists the real cart + one organic alternative per line.
4. Friend clicks **swap** → cart-share calls the `amazon` plugin's **write** endpoint with the
   friend's scoped token → the item is **actually replaced in the owner's real amazon.com cart**
   (remove ASIN X, add ASIN Y), enforced server-side to stay within the capability.
5. Owner's re-read (and amazon.com itself) shows the swapped item. Receipt logs it. Revoke works.
6. Friend attempting checkout / any non-substitute action → 403 by scope (already demoed for the
   fake path; must hold for the real token).

## Work items

### A. oauth3-server — `amazon` plugin cart-write capability  (repo: teleport-computer/oauth3-server)
- Add a write op to the `amazon` plugin: `substitute(jar, {removeAsin, addAsin, qty})` = remove the
  active-cart line for `removeAsin` and add `addAsin`. Also expose the primitives it needs
  (add-by-ASIN, remove-line) if that's cleaner.
- **Investigate the real endpoints first, adversarial-interop style** — do NOT guess markup again.
  Capture a real cart mutation from a logged-in browser session (as we did for the read): the
  active cart posts to `/gp/cart/ajax/update.html` / `/gp/aws/cart/add.html` etc. and carries an
  anti-CSRF token that must be scraped from the cart page. Writes are more likely than the read to
  hit the bot wall — if the raw authed POST is blocked, use the **browser-path** (the plugin already
  has `renderUrl` + a screenshot path; drive a real browser to perform the edit). Document which
  path worked.
- **Scope enforcement (server-side, not trusted from client):** a token whose only cap is
  `amazon:cart-substitute` may ONLY do remove-one + add-one within a price band and same category;
  it must be REJECTED (403) for checkout, address, payment, quantity-bomb, or arbitrary add. Add a
  cap-gated route (mirror the existing read gate in `handler.ts`).
- Register the `amazon:cart-substitute` scope ingredient/capability so it can be minted + attenuated.

**Acceptance (must all be demonstrated e2e, no mocks):**
1. With the real vault jar, calling the write substitutes an item and a subsequent `/gp/cart` read
   shows the change. Include the before/after cart JSON in the evidence.
2. A `amazon:cart-substitute` token is rejected (403) for checkout and for a non-substitute write.
3. Unit tests for the scope gate + the endpoint/CSRF parsing (mirror `amazon_test.ts`, real markup).
4. `deno check` + `deno test server/plugins/amazon_test.ts` green.

### B. webhost-apps — cart-share uses the real delegation + real write  (repo: amiller/webhost-apps, branch cart-share-v2)
- `POST /share`: instead of `tok()`, call the core to mint a real attenuated `amazon:cart-substitute`
  token delegated from the connected owner. Put it in the `?cap=` link. `revoke` must revoke the
  real token in the core.
- `POST /friend/substitute`: instead of mutating `cart[]`, call the `amazon` plugin write with the
  friend's scoped token (removeAsin = the line, addAsin = the suggested organic alternative). On
  success, re-read the real cart and update the view + receipt from the truth, not from a local edit.
- Friend view + owner receipt reflect the REAL post-swap cart (re-read after write).

**Acceptance (must all be demonstrated e2e, no mocks):**
1. Full walkthrough on the real cart: owner connects → invites → friend opens link → friend swaps
   the jerky (or whatever's in the active cart) for an organic alternative → the swap is visible in
   the owner's real amazon.com cart AND on owner re-read. Screenshots of amazon.com before/after.
2. Friend checkout attempt → 403 (real token, real gate).
3. Revoke → friend's next swap fails.
4. Client `node --check` + `deno check server.ts` green.

## Definition of done / the morning report
A single evidence report (journey walkthrough + before/after screenshots of the REAL amazon.com
cart, and the before/after cart JSON) proving A + B end-to-end. If Amazon's bot wall blocks the
write and it needs the browser-path, say so and show the browser-path working — do not report a
mock as success. If any acceptance check can't be met, report it as NOT done with the blocker, not
as green.

## Anti-patterns (these caused the rework this spec exists to fix)
- Do not hand-author Amazon markup fixtures from imagination — capture real markup.
- Do not claim a flow works from an API/curl check; verify the actual rendered result.
- Do not mutate a local copy and present it as writing to the real cart.
