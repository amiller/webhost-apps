# timeline-peek

A minimal OAuth3 relying-party demo. It reads the timeline from the pod's
`/oauth3/api/twitter/feed` — **the app never touches cookies**; the TEE pod does the
authenticated read and hands back only the feed. It obtains a **scoped `twitter` token over one
of two connect paths**, and a redesign MUST keep both (see *Spec impact* below):

- **Extension path (owner / desktop).** When `window.oauth3` is present,
  `window.oauth3.connect()` asks the browser extension for the scoped token (the original flow).
- **Wallet path (mobile / clean profile — issue #9).** When `window.oauth3` is **absent**, the
  app self-provisions an Ed25519 `did:key` wallet in this browser, signs into the node
  (`POST /oauth3/api/login`), runs the `/oauth3/api/connect` handshake, and approves it — yielding
  the same scoped `tok-twitter-*` with **no extension**. `onConnect()` routes on
  `if (!window.oauth3) connectViaWallet()`. This path is **load-bearing**: phones and clean
  profiles have no extension, and without it the app dead-ends (the #9 regression).

Single self-contained `index.html` (no build, no backend). Deploy as a `static` project with
`entry: index.html`.

**Capability sharing** uses [`share-kit`](../share-kit/) — the suite's one shared
share UI. The owner gets a `Share my feed →` action + a capability receipt (link,
plain-English scope sentence, Revoke, status pill); the shared view shows a recipient
banner with an honest revoked/gone end-state when the token is rejected.
`share-kit.js` is **inlined** into this `index.html` (single-file static app) inside the
`<!--share-kit:inline-->` block — refresh it with `../share-kit/inline.sh timeline-peek`.

> Source rescued 2026-07-02 from the running pod (`pod.dstack.soc1024.com/timeline-peek`) —
> it had been deployed (Jun 30) without a committed source. See ../POD-APPS-AUDIT.md.

### Rendering & `?demo`

The viewer mirrors x.com's chrome (sticky `For you`/`Following` tabs, avatar + display-name +
@handle + timestamp, entity-styled text, read-only engagement row with proper SVG icons, media
grids at Twitter's aspect ratios, dark/light themes). Three modes: `?demo` renders bundled sample
data (clearly labeled) so the rendering is reviewable without a live token; `?token=<scoped>` is a
public share; default is the OAuth3 `Connect` flow.

The feed endpoint reconstructs posts from the rendered page's **innerText**
(`oauth3-server/server/browser.ts` `parseFeed()`), so items today carry
`{name, handle, time, text, stats}` and **no media/avatar/verified fields**. This viewer is
**media-ready**: items that carry `avatar`, `verified`, or `media:[{type,url,poster}]` render them.
Showing *real* tweet media therefore also needs `parseFeed()` to scrape the media DOM — a change in
the `oauth3-server` repo, not this one.

## Spec impact — #63 (2026-07-27)

**The defect.** Issue #9 (operator-ask) added the no-extension wallet sign-in path in #31
(2026-07-09). PR #48's x.com redesign (2026-07-10) rewrote `index.html` and **silently dropped**
it — the owner path went back to `window.oauth3.connect()`-only and dead-ended on any browser
without the extension. The regression went unnoticed because this README's opening paragraph
described the app as extension-only ("It asks the browser extension … via
`window.oauth3.connect()`"), so #48's extension-only rewrite matched the documented contract.
**That is the document that permitted the defect, and it is the line amended above** — the
description now states both connect paths and marks the wallet path load-bearing.

**Rule going forward.** Any rewrite of `index.html` MUST preserve both branches of `onConnect()`:
the `window.oauth3` extension branch **and** the `connectViaWallet()` no-extension branch. The
acceptance in #9 ("opened WITHOUT the extension … a 'Sign in with OAuth3' wallet flow appears
instead of a dead-end") is a permanent, re-verifiable contract, not a one-time fix.
