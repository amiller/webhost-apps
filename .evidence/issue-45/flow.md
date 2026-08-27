# Issue #45 — timeline-peek: render like the real Twitter feed — flow evidence

## What this PR adds on top of #48 (the redesign, already on staging)

#48 shipped the x.com-mirror rendering (media grids, tabs, themes, engagement row) and made
the app media-ready. But the deployed app **could not load the real feed at all**: share-kit's
`oauth3Read` aborted at 15s, and the twitter read is browser-SPI-backed on the node
(inject jar → navigate → 4s settle → eval), measured **13.374s** against staging on 2026-08-27
(and **15.62s** on the rework re-verification the same evening) — the client abort raced the
server read, so the signed-in feed reliably died as `couldn't reach the oauth3 node (request timed out)`.

This PR adds `opts.timeoutMs` to `ShareKit.oauth3Read` (default 15s unchanged for every other
caller) and passes `{timeoutMs: 60000}` at timeline-peek's two feed reads. share-kit 0.4.1,
inlined block regenerated via `share-kit/inline.sh timeline-peek` (re-verified byte-identical
after the rebase onto #154).

**Rebase (rework pass, 2026-08-27):** rebased onto `origin/staging` @ `ab19cdd` (#154's
mount-aware `NODE` + `?node=` override). The one conflict in `timeline-peek/index.html` was
resolved keeping BOTH intents: #154's node derivation/override, #45's `FEED_TIMEOUT_MS`.
All evidence below was **regenerated on the rebased bytes** deployed as staging project
`timeline-peek-fix45` (tree `c282d9bf`); the pre-fix shot is from the **main** staging app,
pinned at walk time to bytes without `FEED_TIMEOUT_MS` (#154 bytes, which contain the timeout
bug this PR fixes).

## Steps (envoy real-browser bridge — real Brave, real pointer events, no CDP; flock-serialized)

1. **Raw read, no client abort** (curl from the rig host, 2026-08-27 evening re-run):
   `GET /oauth3/api/twitter/feed` → **HTTP 200 in 15.62s**, `who: socrates1024`, items
   present (count + shape in `01-signed-in-read-transcript.txt`; content redacted — personal data).
2. **Pre-fix, deployed main staging app** (`/timeline-peek/`, #154 bytes — timeout bug present):
   navigate `?token=<scoped>` → after share-kit's 15s abort the app renders the honest terminal
   error, asserted live: `note.className = "note err"`, text **`couldn't reach the oauth3 node (request timed out)`**, `article.tweet` count **0**. → **`02-pre-fix-terminal-error.png`** (committed: an error state, no personal data)
3. **Post-fix, this branch rebased and deployed** (`/timeline-peek-fix45/?node=<staging>/oauth3&token=<scoped>` —
   the `?node=` override from #154 carrying #45's 60s budget, i.e. the two intents integrated):
   **real feed renders: 7 tweet articles**, `document.title = "@socrates1024 / Home / Timeline Peek"`,
   first-article header has name/@handle/time (content NOT logged — personal data); 0 `<img>` in
   the feed (no `media` fields yet — see honest split below). Verified in-session; **the
   screenshot is NOT committed** — it is the operator's personal timeline (standing LESSON:
   no real personal data in this public repo).
4. **Demo mode on the rebased branch deploy** (`?demo`, clearly-labeled sample data): 6 articles,
   **16 media images loaded** (naturalWidth>0), footer **"Demo · sample data. Connect with OAuth3
   to see your real timeline."** → **`03-demo-media-grids.png`** (committed; labeled sample)

## Acceptance status — honest split

- "Signed-in feed screenshot side-by-side with a real x.com screenshot" — the signed-in feed
  **renders post-fix** (step 3, verified in-session; private shot only). The committed shots are
  the pre-fix error (the user-visible bug this PR removes) and the labeled demo render. The
  x.com half of the side-by-side was NOT captured: the bridge browser has no logged-in x.com
  session (HttpOnly cookies cannot be set from page JS; transplanting the operator's cookies is
  operator-run by standing rule), and x.com's CSP blocks the bridge's evaluate on its pages.
- "Tweets with images show the images" — the rendering path is proven (`03-demo-media-grids.png`,
  16 loaded images); **real** tweets still carry no `media`/`avatar`/`verified` fields until
  oauth3-server's `parseFeed()` (`server/browser.ts:49`, innerText-only as of 2026-08-27)
  scrapes them — cross-repo (`teleport-computer/oauth3-server`), unchanged by this PR.
