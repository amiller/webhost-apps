# reddit-karma

A sample OAuth3 relying-party app. It initiates the OAuth3 login flow (Connect) and
renders the connected Reddit account's **saved posts** — recent saved submissions with
their subreddits + a count — read through a **scoped, revocable token** from the OAuth3
node. The app never sees the Reddit cookie; the TEE pod does the authenticated read.

Single self-contained `index.html` (no build, no backend). Deploy as a `static` project
with `entry: index.html`, exactly like `timeline-peek/`.

## The flow

1. **Connect** asks the OAuth3 node for a scoped `reddit` token — via the browser
   extension (`window.oauth3.connect`), or, with no extension present, by
   self-provisioning an Ed25519 `did:key` wallet in the browser and running the
   `POST /api/login` → `POST /api/connect` → `/approve` handshake itself (the same
   extension-optional path `timeline-peek` and `calendar-share` use).
2. With the token it does `GET /oauth3/api/reddit/items` (Bearer) and renders the saved
   posts (subreddit + title + date) with a count, in a card stamped `live`.
3. Either way the app only ever holds the scoped token — it can do nothing but read
   your saved posts with it, and the owner can revoke the link at any time.

## Plugin contract (consumes oauth3-server#83)

This app reads saved posts from the Reddit API plugin tracked in
[`teleport-computer/oauth3-server#83`](https://github.com/teleport-computer/oauth3-server/issues/83).
The shipped read route is **`/items`** (the `/account` karma route was never shipped and
returns 404 — see issue #64). The endpoint this app expects is:

```
GET /oauth3/api/reddit/items       Authorization: Bearer <scoped token>
→ 200 { plugin:"reddit", data:[{id,title,date,meta:{subreddit,...}}] }
```

(Response key is `data`, not `items`.) The TEE must have a synced reddit session jar
(`reddit_session` cookie, synced by the operator via `POST /api/cookies`); without one
the route returns `409 {"error":"no jar synced for reddit"}`, which this app renders as
the real error — no mock, no fallback.

There is no mock path. If the live read fails for any reason (plugin not registered, no
reddit jar synced, network, denial), the real error and HTTP status go into the evidence
block, and a plain error state renders in the card — no posts, never fake content.

## Deploy

Static tarball to the tee-daemon (`POST /_api/projects`, Bearer `TEE_DAEMON_TOKEN`),
`runtime: static`, `entry: index.html`. No app secrets.

## Notes / debt

- The wallet self-provision block is duplicated from `timeline-peek` / `calendar-share`
  (a third copy now). It's a candidate for a shared module the way `share-kit` is — left
  inline here to match the existing convention rather than refactor siblings in this issue.
- Saved posts are a personal read, so (unlike `timeline-peek` / `calendar-share`) this
  app does not wire `share-kit` — there is no capability to share onward.
