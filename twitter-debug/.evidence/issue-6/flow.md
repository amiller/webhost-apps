# Flow evidence — issue #6: twitter-debug renders media (images/video) in the timeline

Branch `ready-6` (base `staging`) · 2026-08-15 · envoy bridge (real Brave via the neko rig, no CDP).

## What this walk proves (on this box)
1. **`01-demo-feed-rendered.png`** — the new dashboard card ⑧ "Timeline — the feed, rendered" with tweet
   cards: avatar, name/handle, text, and an inline media grid (photo card + photo/video-thumbnail grid).
   Every image src is `twitter/media?u=<b64url>` — the same-origin relay. The data here is the
   clearly-labeled `?demo` sample (public twimg brand assets); the operator's real feed is personal data
   and stays out of this public repo (LESSONS 2026-07-11).
2. **`03-walk-assertions.txt`** — the assertions above as raw evaluate() results, plus:
   - `performance` resource entries matching `twimg.com` = **0** — the page makes ZERO direct twimg
     requests; media flows only through `/twitter/media` (acceptance bullet 3, measured by the browser).
   - the media relay returning **real** twimg bytes: photo → `200 image/jpeg` (JPEG magic), real mp4 with
     `Range: 0-2047` → `206 video/mp4` (MP4 magic — the click-to-play path), non-twimg → `400`.
   - `mapTimeline` run against a **real HomeTimeline capture** (engine recipe + the rig's standing jar):
     `{tweets:35, with_media:11, photos:11, videos:2}`, every tweet carries `media[]`, t.co stubs stripped,
     video entities = best-bitrate mp4 + poster. The capture itself (the operator's real feed) is NOT
     committed; entity ids/tokens are redacted in the transcript.
3. **`02-feed-op-honest-error-local.png`** — the REAL `read timeline (feed)` op driven from the page on the
   local (non-pod) instance: it renders an honest error (`no jar loaded — connect X via OAuth3`) — the jar
   is sealed in the pod TEE. No mock, no masking.

## What could NOT be verified on this box (operator steps — no prod creds here, by design)
- The value-state walk on the **deployed pod** (signed-in, connected): run `read timeline (feed)` → real
  tweets with real photos + video thumbnails in-card; DevTools network filtered to `twimg.com` → empty.
  Requires: merge → `twitter-debug/deploy.sh` (ghcr push + prod daemon, operator-only) → walk
  `https://pod.dstack.soc1024.com/twitter-debug/`.
- The rettiwt-path media mapping (`POST /twitter/api {op:timeline}`) — rettiwt is rejected on this egress
  before GraphQL (`Unknown error`, the app's documented thesis), so its mapper is code-reviewed only.
- Engine `timeline` end-to-end on the pod — fixed to parse+map its response and to fall back to the
  browser-observed queryId (HomeTimeline left main.js's chunk in 2026-08); verified only via the identical
  local engine recipe (see 03-walk-assertions.txt), not through the deployed pod's engine route.

## Parse/type checks
`tsc --noEmit --skipLibCheck` on server.ts: **0 errors** (with @types/node, not shipped).
Inline dashboard script: `node --check` **OK**.
