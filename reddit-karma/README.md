# reddit-karma

A sample OAuth3 relying-party app. It initiates the OAuth3 login flow (Connect) and
renders the connected Reddit account's **karma** — total, with comment / post breakdown —
read through a **scoped, revocable token** from the OAuth3 node. The app never sees the
Reddit cookie; the TEE pod does the authenticated read and hands back only the karma.

Single self-contained `index.html` (no build, no backend). Deploy as a `static` project
with `entry: index.html`, exactly like `timeline-peek/`.

## The flow

1. **Connect** asks the OAuth3 node for a scoped `reddit` token — via the browser
   extension (`window.oauth3.connect`), or, with no extension present, by
   self-provisioning an Ed25519 `did:key` wallet in the browser and running the
   `POST /api/login` → `POST /api/connect` → `/approve` handshake itself (the same
   extension-optional path `timeline-peek` and `calendar-share` use).
2. With the token it does `GET /oauth3/api/reddit/karma` (Bearer) and renders total /
   comment / post karma in a card stamped `live`.
3. Either way the app only ever holds the scoped token — it can do nothing but read
   karma with it, and the owner can revoke the link at any time.

## Plugin contract (consumes oauth3-server#83)

This app reads karma from the Reddit API plugin tracked in
[`teleport-computer/oauth3-server#83`](https://github.com/teleport-computer/oauth3-server/issues/83).
The endpoint this app expects is:

```
GET /oauth3/api/reddit/karma        Authorization: Bearer <scoped token>
→ 200 { data: { name, total_karma, comment_karma, link_karma, created_utc } }
```

`#83` is still **open** — on any instance where the plugin isn't registered yet, the live
read fails honestly: the real error and HTTP status go into the evidence block under the
number, the card is stamped **MOCK**, and clearly-labelled sample karma renders so the
demo is viewable end-to-end today. When `#83` ships, real karma renders here with **no
code change**. The **View demo (mock)** button shows the mock without attempting a login.

Nothing is masked: a failed connect/read never silently becomes "0 karma" — the failure
is surfaced as evidence and the card is honestly stamped MOCK.

## Deploy

Static tarball to the tee-daemon (`POST /_api/projects`, Bearer `TEE_DAEMON_TOKEN`),
`runtime: static`, `entry: index.html`. No app secrets.

## Notes / debt

- The wallet self-provision block is duplicated from `timeline-peek` / `calendar-share`
  (a third copy now). It's a candidate for a shared module the way `share-kit` is — left
  inline here to match the existing convention rather than refactor siblings in this issue.
- Karma is a personal read, so (unlike `timeline-peek` / `calendar-share`) this app does
  not wire `share-kit` — there is no capability to share onward.
