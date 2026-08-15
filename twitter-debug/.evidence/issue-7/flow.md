# #7 — twitter-debug: "Share my feed" (scoped, revocable feed link) — PR #145

## Acceptance (from the issue)
1. On twitter-debug signed in, **Share my feed** mints a scoped `twitter` read token and renders the
   `…/timeline-peek/?token=<scoped>` link with the true-scope sentence and a Revoke control.
2. Opening that link (no extension, not signed in) renders the same feed the owner sees.
3. After Revoke, the link shows timeline-peek's honest end state — never a blank or silently empty feed.

Evidence tier: **Tier 2** — walked signed-in (wallet identity) on deployed webhost-staging with the real
envoy/neko Brave + the real OAuth3 extension, click-by-click, screenshots below.

---

## Where it was walked (and why not the pod URL)
The issue's acceptance names `https://pod.dstack.soc1024.com/twitter-debug/` (prod, operator-run — no
prod daemon token on this box by design). The swarm's staging is the webhost-staging tee-daemon, which
serves `/oauth3` and `/timeline-peek` on the SAME origin the share flow is wired for
(`location.origin+'/oauth3'`, `location.origin+'/timeline-peek/'`). This branch's `twitter-debug/web/`
was deployed to webhost-staging as a static project (the enclave image path needs a ghcr push this
box's credentials lack — pull-only docker auth, gh token without `write:packages`); the share surface
it exercises (extension mint → node → viewer → revoke) is entirely client-side and ran for real.
The full enclave image on the pod remains the operator step it always was.

## Environment changes this walk needed (both documented, both real)
- **oauth3-server `staging-oa-21`** (`d951fa7`): staging's static connect-gate listing admitted
  `twitter-debug` (read-only, twitter plugin, discharge 1) — same precedent as the calendar-share /
  zai-usage / passbook admissions. Before it, `POST /api/connect` answered
  `403 App "twitter-debug" is not listed`. The pod node already lists twitter-debug.
- **webhost-staging project `twitter-debug`** (static, from this branch, tree `8bfc7415…`).

## The walk (2026-08-15, rig identity = the envoy browser's OAuth3 wallet, subject `u-9c0e1e82…`)
The wallet's twitter jar on the staging node is the real synced x.com jar (`auth_token`+`ct0`, 20
cookies, account `<redacted>`); reads reconstruct the live logged-in render via the browser-pool SPI.

1. **01-owner-share-card.png** — staging `/twitter-debug/`, share card in view, button
   `Share my feed →` (DOM-asserted present; `window.oauth3` wallet present).
2. **01b-consent-dialog.png** — clicking the button raises the extension's consent dialog
   (`twitter-debug wants to read your twitter — with a scoped, revocable token, never your cookies`);
   its **Connect** button was clicked (the user gesture that carries the approval).
3. **02-receipt.png** — after the mint, the receipt renders the
   `…/timeline-peek/?token=tok-twitter-22388da8…` link, the true-scope sentence
   `read-only · your X For-You feed · nothing else`, status pill `active`, and the **Revoke** control.
   Node-side: `connect.request` + `connect.approve` + `token.mint` for app `twitter-debug` in the audit.
4. **Recipient reads (no session, extension not required)** — raw HTTP with the token only:
   `GET /oauth3/api/twitter/feed` → **200**, real items (8), same account as the owner-token read
   (`who` identical; byte-identical items in the overlap window — the X For-You timeline reshuffles
   per render, so strict first-position equality is unstable by the feed's nature; see transcript.txt
   for the item hashes). The real browser render (9 cards) was verified in-session and screenshotted,
   but the operator's real timeline is personal data — per LESSONS 2026-07-11 that shot stays out of
   the repo. **03-recipient-render-SAMPLE.png** is the committed render proof: timeline-peek's own
   clearly-labeled `?demo` sample ("Demo · sample data"), same render path.
5. **Revoke — defect found and fixed in this PR.** As shipped (e042969) the receipt's Revoke did a
   bare same-origin `DELETE /oauth3/api/tokens/<tok>`; the daemon proxy strips cookies and the node
   requires owner-secret or a session, so the live node answered **401 unauthorized** (verified before
   fixing). Commit `8d25688` fixes it: the page asks the wallet for its session for this node
   (`window.oauth3.signIn({node})` — extension-refused for any other origin) and revokes with that
   bearer. **04a-receipt-revoked.png** — Revoke clicked (real button): pill `revoked`, button disabled
   `Revoked`; node-side `revokedAt` set (both minted tokens, timestamps in transcript.txt).
6. **04b-recipient-end-state.png** — opening the revoked link in the browser: timeline-peek renders
   the honest end state (`#note.err` = `unauthorized`, the real error from `/api/twitter/feed`; feed
   empty) — not a blank or silent stall.

Hygiene: every `twitter-debug` token minted during this walk is revoked.

## What I could NOT verify
- The **pod** (prod) deployment of this branch's dashboard (image build + ghcr push + prod daemon
  token — none available on this box). The staging walk above exercises the identical client code
  against the real node/viewer; the enclave-only surfaces (live `twitter/shot` stream, engine writes)
  are pod features outside this PR's share scope.
- Strict first-tweet-text equality between owner and recipient views: the For-You feed is
  non-deterministic across renders; demonstrated instead by same-account reads with byte-identical
  overlapping items (hashes in transcript.txt).

## Artifacts
`01-owner-share-card.png`, `01b-consent-dialog.png`, `02-receipt.png`,
`03-recipient-render-SAMPLE.png`, `04a-receipt-revoked.png`, `04b-recipient-end-state.png`,
`transcript.txt` (redacted HTTP transcript: connect/mint, reads, hashes, revocations).
