# calendar-share

The **write-side sibling of `timeline-peek`**. A relying-party app signed in as the
operator's Google Calendar account (`cube@shaperotator.xyz`) that **mints a share code**
— a link that lets whoever opens it *edit one specific event* on the account's behalf,
and nothing else. Revocable. Where `timeline-peek` publishes a read-only feed, this
publishes a single-event write delegation.

A thin deno app (`server.ts` + `project.json` + `deploy.sh`, mirroring `otterpilot/`)
serving one self-contained `public/index.html` (no build, no client framework). The page
is mounted at `/calendar-share/` next to the OAuth3 node so the browser's
`NODE = location.origin + "/oauth3"` resolves, with `<base href="/calendar-share/">`
pinning relative fetches (the same #16 trap `otterpilot`/`timeline-peek` guard against).

The server holds **no secrets**: unlike `otterpilot` there is no owner token to keep
server-side. Every oauth3 call is made by the browser itself — the owner's read token
comes from the extension (or the self-provisioned wallet) and the recipient's write token
travels in the share URL. The delegation envelope (cap check, attenuation, audit,
revocation) lives entirely in the oauth3 node, enforced against the token the client
presents.

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

## Env

- `OAUTH3_NODE` — the pod's oauth3 instance (default `https://pod.dstack.soc1024.com/oauth3`).
  Advisory: the page recomputes the node from `location.origin`, so the app works unchanged
  wherever it's mounted beside an oauth3 sibling. Kept in `project.json` for consistency
  with the rest of the suite.

## Deploy

`bash deploy.sh` — tarballs `server.ts` + `project.json` + `public/`, POSTs to the daemon
(`POST /_api/projects`, Bearer `TEE_DAEMON_TOKEN`). The only credential is the daemon
token (no app secrets). For staging verify:
`source ~/.tee-daemon-staging.env && CVM="$TEE_DAEMON_URL" bash deploy.sh`, then
`GET $CVM/calendar-share/` → 200. Prod (the app's real home) is operator-run — set
`CVM=https://pod.dstack.soc1024.com` and a prod `TEE_DAEMON_TOKEN`.

## Depends on

`oauth3-server#69` — the `google-calendar` plugin + the `write:event:<id>` cap + the
`POST /api/google-calendar/event/:id` endpoint — shipped to **prod** on 2026-07-07
(`GET https://pod.dstack.soc1024.com/oauth3/api/plugins` lists `google-calendar`). The
live mint → edit → reject-other-event journey therefore runs against **prod** (needs the
prod oauth3 node + the synced cube@ jar); on the staging daemon the plugin is absent, so
only static serving (`GET /calendar-share/` → 200) is verifiable there. Prod deploy + the
jar sync are operator-run; this PR ships the deployable app and the static-serving proof.
