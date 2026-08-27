# Issue #45 — timeline-peek: render like the real Twitter feed — flow evidence (2026-08-27)

## What this PR adds on top of #48 (the redesign, already on staging)

#48 shipped the x.com-mirror rendering (media grids, tabs, themes, engagement row) and made
the app media-ready. But the deployed app **could not load the real feed at all**: share-kit's
`oauth3Read` aborted at 15s, and the twitter read is browser-SPI-backed on the node
(inject jar → navigate → 4s settle → eval), measured **13.374s** against staging today — the
client abort raced the server read, so the signed-in feed reliably died as
`couldn't reach the oauth3 node (request timed out)`.

This PR adds `opts.timeoutMs` to `ShareKit.oauth3Read` (default 15s unchanged for every other
caller) and passes `{timeoutMs: 60000}` at timeline-peek's two feed reads. share-kit 0.4.1,
inlined block regenerated via `share-kit/inline.sh timeline-peek`.

## Steps (driven through the envoy real-browser bridge, Brave on :3002, flock-serialized)

1. **Pre-fix state, observed live on the deployed staging app** (origin/staging bytes,
   verified byte-identical at the time): navigate
   `$WEBHOST_STAGING/timeline-peek/?token=<scoped>` → the app rendered the honest terminal
   error `couldn't reach the oauth3 node (request timed out)` (15s abort), 0 tweets. → `01-signed-in-read-transcript.txt`
2. **The same read over raw HTTP** (no client abort): `200` in **13.374s**, `who:
   socrates1024`, 8 items, item keys `handle, name, stats, text, time` — **no `media` /
   `avatar` / `verified` fields**: `oauth3-server/server/browser.ts parseFeed()` still parses
   page `innerText` only (verified in the oauth3-server checkout, 2026-08-27). → `01-signed-in-read-transcript.txt`
3. **Post-fix, signed-in share-mode on the deployed branch** (staging project
   `timeline-peek-fix45`, tarball of this PR's HEAD, same origin so `NODE = location.origin +
   "/oauth3"` resolves): navigate `?token=<scoped>` → **the real feed renders: 11 tweet
   articles**, first article a real post (display name + @handle + timestamp verified via
   bridge evaluate; content redacted here — this is the operator's personal timeline, per the
   standing LESSON the real-feed screenshot is NOT committed to this public repo; it was
   verified in-session and lives only on the box).
4. **Demo mode on the served branch** (`?demo`, clearly-labeled sample data): 6 articles,
   16 media images rendered in x.com aspect-ratio grids, footer "Demo · sample data. Connect
   with OAuth3 to see your real timeline." → `02-demo-media-grids.png` (committed; the
   media-grid rendering path this issue is about).

## Acceptance status — honest split

- "Tweets with images show the images" — the rendering path is proven (`02-demo-media-grids.png`);
  **real** tweets still carry no `media` fields until `oauth3-server` `parseFeed()` scrapes
  them (cross-repo, `teleport-computer/oauth3-server`; unchanged as of 2026-08-27).
- "Signed-in feed screenshot side-by-side with a real x.com screenshot" — the signed-in feed
  **now renders** (step 3, verified in-session); the side-by-side with live x.com was NOT
  captured: the bridge browser has no logged-in x.com session (HttpOnly cookies cannot be set
  from page JS, and transplanting the operator's cookies is operator-run by standing rule),
  and x.com's CSP blocks the bridge's evaluate on its pages. Committed evidence is the
  labeled demo per the personal-data LESSON.
