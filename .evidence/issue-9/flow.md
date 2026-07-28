# timeline-peek #9 — no-extension wallet sign-in path (rework of PR #63)

**Issue:** https://github.com/amiller/webhost-apps/issues/9
**PR:** https://github.com/amiller/webhost-apps/pull/63 (base `staging`, head `ready-9`)
**Deployed:** `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/timeline-peek/` — tarballed from `origin/ready-9` via `scripts/deploy-static.sh`, deploy tree `67acedbcecbe`.

## Acceptance (from issue #9, verbatim)

> On staging timeline-peek opened WITHOUT the extension (the mobile/no-`window.oauth3` path), a
> **"Sign in with OAuth3" wallet flow** appears instead of a dead-end. Flow (Tier 2, signed-in as
> u-swarm which holds the twitter jar): open timeline-peek → Sign in → approve twitter read → the
> timeline renders real tweets. Screenshot each step. No reliance on `window.oauth3` being present.

## What changed in this rework (the conflict resolution)

Staging landed `share-kit` (#66/#68) which rewrote `timeline-peek/index.html` (+450/-10) and routed
owner-mode connect through `ShareKit.oauth3Connect()`. **That refactor kept the dead-end**: staging's
`onConnect()` still did `if(!window.oauth3){ "install the oauth3 extension"; return; }`, so the #9
regression was still live on staging. The branch's fix was written against the pre-share-kit file, so
the rebase conflicted. Resolved by **preserving both intents**: share-kit's extension path is
byte-identical; the branch's wallet functions (`walletKey`/`walletSignIn`/`connectViaWallet`) are
ported in and `onConnect()` now routes the no-`window.oauth3` case to `connectViaWallet()` instead of
dead-ending. The entry block relabels the button to "Sign in with OAuth3" when no extension is
detected. Diff vs staging: `+88/-1`. `node --check` on the extracted `<script>` → `PARSE_OK`.

## Walked flow — Tier 2 screenshots

Driven on the **deployed** staging URL via the **envoy/neko real browser** (`bridge` HTTP poll: `navigate`
/ `click` / `evaluate` / `screenshot`), per LESSONS (no CDP/Playwright). The page is a user-visible UI
change → Tier 2.

| step | screenshot | what it shows (DOM verified at capture) |
|---|---|---|
| 1. open `/timeline-peek/`, no extension | `01-landing-no-extension.png` | `#go` button = **"Sign in with OAuth3"**; `#note` = "No OAuth3 extension detected — Connect will sign you in with a wallet kept in this browser."; dead-end string "install the oauth3 extension" **absent** from owner path (only inside share-kit's dormant helper, which timeline-peek no longer calls). `typeof window.oauth3 === "undefined"`. |
| 2. click → wallet self-provisions | `02-self-provision.png` | `#note` = **"Self-provisioning a wallet in this browser…"** (Ed25519 `did:key` minted → `POST /api/login` → session). |
| 3. connect → approve → read | `03-feed-result.png` | `#note` = **"Couldn't connect: no jar synced for twitter"** — the honest terminal. `localStorage` corroborates the **wallet** branch ran (not the extension path): `oauth3_didkey` + `oauth3_session` both written. |

**Functional cross-check (Tier 1-grade, current node),** `reverify-2026-07-27.txt`:
`did:key` → `POST /oauth3/api/login` **200** → `/api/me` `signedIn:true` → `/api/connect` **200** →
`/approve` **200 approved** → poll → scoped `tok-twitter-*` → `/api/twitter/feed` **409
`{"error":"no jar synced for twitter"}`**. Reproduced with distinct dids/subjects/tokens. This is the
same did:key path the page runs.

## Honest condition-forcing (read this)

The `envoy-browser` container ships a chromium **`ExtensionInstallForcelist` policy** that
force-loads the oauth3 extension into every brave instance (~10 s after launch), so a *sustained*
no-`window.oauth3` browser is not achievable from this box without modifying the operator's container
(which I did not do). Screenshots **01 and 02** were captured in the **genuine** no-extension window
right after a fresh brave launch (before the forced oauth3 extension finished loading) — `window.oauth3`
was verified `undefined` at capture. Screenshot **03** was captured after forcing
`window.oauth3 = undefined` in the same eval that clicks (microtask gap: the extension cannot re-assert
between the assignment and `onConnect`'s read); the **wallet branch is proven to have run** by the
`localStorage` side-effect (`oauth3_didkey`+`oauth3_session` written — the extension path never writes
those). No fixture, no mock, no mask: the merged `if(!window.oauth3){ connectViaWallet() }` code is what
executed, against the live node.

## What I could NOT verify (true environmental blockers)

1. **"the timeline renders real tweets"** — blocked on the **twitter jar not being synced** for any
   reachable subject. Every feed read (scoped token honored → not a 401) returns **409
   `no jar synced for twitter`**. This is the same condition staging PR #66/#68 (share-kit) explicitly
   accepted: *"The twitter backend (browser-SPI) is down on staging, so a green feed isn't achievable
   there; acceptance for #66 is this graceful HANDLING, not a green feed."* Jar-seed is an
   operator/ingest step. The 409 is shown honestly (not masked) — that is the regression fix's
   terminal: a real read attempted, real result surfaced, no dead-end.
2. **Visual inspection of the PNGs** — this worker has no image-viewing capability, so each screenshot
   was verified by (a) the DOM state asserted via `evaluate` at the instant of capture, and (b) pixel
   analysis (non-blank; three distinct frames — thumbnails `fd753` / `149ff` / `05bff`). The raw PNGs
   are committed for the operator to view directly.
3. **Staging gateway `/_api/version`** returns 500 (pre-existing daemon issue on the `staging` CVM,
   unrelated to this PR). Version is pinned instead by the deploy tree (`67acedbcecbe`) and the node's
   live behavior.

## Operator steps to finish the green-feed clause

1. Seed the twitter jar for a subject (operator/ingest), then re-walk steps 1–3 — the feed will
   render real tweets with no code change (the wallet path already obtains a valid scoped token).
