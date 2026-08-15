# PLAN — #6 twitter-debug: render media (images/video) in the timeline

Base: `origin/staging` · Worktree: `/tmp/app-6` · Branch: `ready-6`

## Acceptance (from the issue, verbatim)
- [ ] The deployed twitter-debug `timeline` op returns each tweet with a `media[]` array of `{type: "photo" | "video", url}`. Today the mapper emits only `{id, text, by}` (`twitter-debug/server.ts:301`).
- [ ] The rendered timeline shows those inline in the tweet card — at least one real image and one video thumbnail visible in the walked flow, not a text wall.
- [ ] Media loads through the pod (a same-origin proxy route, the way the otter `/frame` proxy works): with the network panel filtered to `twimg.com` there are zero requests from the page.

## Reality on the box (2026-08-15, probed live)
- Deployed prod app: rettiwt blind path = `Unknown error` (X blocks it on pod egress — the app's thesis);
  `engine timeline` = "queryId for HomeTimeline not in bundle" (X moved queryIds out of main.js);
  `reify` = **works** (browser-observed HomeTimeline replay: 200, 37 entries). → the feed must ride the reify path, as the issue text says.
- Reproduced the engine recipe from THIS box with the rig's jar (`~/.paseo-secrets/jars/x.com.json`, standing
  credential) + browser-observed queryId: 200, 35 tweets, **11 photos + 2 videos** at count=50. Real media entities
  confirmed at `legacy.extended_entities.media[]` (`media_url_https`, `video_info.variants[].url` mp4).
- twitter-debug is a `runtime:image` PROD app; no prod deploy creds / ghcr push on this box → the deployed-pod walk is
  operator-run after merge. Local verification covers everything reachable (see VERIFY).

## Build
- [x] server.ts: `mapMediaEntity` / `mapTweet` / `mapTimeline` (GraphQL HomeTimeline JSON → tweets with media[])
- [x] server.ts: rettiwt `timeline` mapper emits media[] too (`ITweetMedia{id,type,url,thumbnailUrl}` shape, rettiwt 7.1.2)
- [x] server.ts: `engine timeline` maps its GraphQL response to tweets+media; queryId fallback to the browser-observed one
- [x] server.ts: `replayHeadless` also returns parsed JSON; new `POST /twitter/feed` = fresh-or-recapture trace → replay → mapTimeline (browser lock+cooldown, like /twitter/reify)
- [x] server.ts: `GET /twitter/media?u=<b64url>` — same-origin twimg-only media proxy (otter /frame pattern; Range pass-through for video)
- [x] web/index.html: card ⑧ "Timeline — the feed": run feed op → JSON (media[] populated) + rendered tweet cards (avatar + media grid, video poster + click-to-play), all media via `twitter/media?u=`; clearly-labeled `?demo` sample (public brand assets on twimg) for render review
- [x] README: endpoints table + media notes

## Verify
- [x] Parse checks: server.ts (esbuild/bun parse — `deno check` can't resolve its npm bare imports), inline script driven in-browser
- [x] `mapTimeline` unit-run against the REAL capture (`/tmp/hometimeline50.json`, stays out of the repo — personal feed data)
- [x] Local run of the REAL server (tsx): `/twitter/media` returns real twimg bytes (curl + magic check), rejects non-twimg; `/twitter/feed` errors honestly (no pod browser)
- [x] Envoy-bridge walk of the local page (`?demo`): cards render, images load, `performance` entries contain ZERO twimg.com requests — screenshots + flow.md in `.evidence/issue-6/`
- [ ] Real-pod walk + DevTools twimg-filter check: OPERATOR step (no prod creds) — exact steps in the PR/issue comment

## Ship
- [ ] commit + push `ready-6`, PR → staging, evidence embedded, `ready` → `in-review`, comment on #6
