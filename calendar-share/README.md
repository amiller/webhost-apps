# calendar-share

The **write-side sibling of `timeline-peek`**. A relying-party app signed in as the
operator's Google Calendar account (`cube@shaperotator.xyz`) that **mints a share code**
— a link that lets whoever opens it *edit one specific event* on the account's behalf,
and nothing else. Revocable. Where `timeline-peek` publishes a read-only feed, this
publishes a single-event write delegation.

Single self-contained `index.html` (no build, no backend). Deploy as a `static` project
with `entry: index.html`, sitting next to the OAuth3 node so `/oauth3` resolves.

## Two modes (one file)

- **owner mode** (no query string) — connect as the synced account via
  `window.oauth3.connect({ plugin:"google-calendar", app:"calendar-share" })`, list the
  account's events, and for a chosen event mint a token carrying the structured cap
  `write:event:<id>`. Rendered as a share URL `?code=<token>&event=<id>`, plus a Revoke
  control. Works with the extension OR by self-provisioning an Ed25519 `did:key` wallet
  in-browser (the same "Continue in this browser" path `timeline-peek` uses).
- **share mode** (`?code=<token>&event=<id>`) — no wallet needed. Loads that one event
  and offers an edit form whose Save PUTs through `POST /api/google-calendar/event/:id`
  with the scoped token. The recipient can edit this event and reach nothing else.

## The delegation model

The share code is a scoped OAuth3 token whose `caps` array carries exactly
`write:event:<eventId>`. The OAuth3 node's `verifyCap` checks the cap with an **exact
string match** — `write:event:A` does NOT satisfy `write:event:B` — so a recipient can
only ever touch the one event the owner named. A read-only (capless) token is rejected
for any write. Every write attempt is audited, authorized or not. The owner can revoke
the share code at any time (`DELETE /api/tokens/:token`).

Only ever talks to the OAuth3 node's `/api/google-calendar/*`; the account's `google.com`
cookies stay sealed in the TEE. Real errors are surfaced, never masked.

## Depends on

`oauth3-server#69` — the `google-calendar` plugin + the `write:event:<id>` cap + the
`POST /api/google-calendar/event/:id` endpoint. Until #69 ships on staging AND the cube@
jar is synced, the live data path returns an honest `"edit path not yet captured"` error
from the plugin — the delegation envelope (cap check, attenuation, audit, revocation) is
verifiable today against the handler code (see the PR body for the proof).
