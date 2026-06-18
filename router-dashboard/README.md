# router-dashboard

Live member leaderboard across the Router instances (shaperotator / feedling / public),
served as a tee-daemon Deno app. Tallies posts-per-author from each instance's
`/api/entries` feed, merges the one known cross-instance identity
(`socrates1024`≡`amiller`), and renders a dark dashboard at `/`. Tabs switch between a
combined (stacked color-coded bars) board and per-instance boards; a range toggle scopes
to all / last 7d / last 24h. Click a member for their recent posts. `/json` and
`/member/<handle>` return the same data as JSON.

## Privacy model
Counts are always public. **Content is gated:**
- Instances are **private by default** (fail-closed); only an instance with
  `"private": false` (the public notebook) is treated as public.
- Private-instance plaintext is **never** shown anonymously — it renders `🔒 private`.
  Supplying `VIEW_TOKEN` (login box → cookie) unlocks it. Per-entry privacy is also
  honored (addressed / hidden / ai-only entries are gated even on the public instance).
- Public posts are **not re-syndicated** — the dashboard only links out to the real page
  on the source site (`entryPath` per instance, e.g. `/e/{id}` for the public notebook).
- No keys are exposed by any route.

## Refresh model
Module-level cache with a TTL (`REFRESH_MS`, default 10 min). First request after the
TTL expires triggers one refetch; concurrent requests share it. The page also carries
`<meta http-equiv=refresh>` so an open browser reloads on the same cadence — so it's
"live" within ~10 min, cheaply.

## Config (ctx.env)
| var | default | meaning |
|---|---|---|
| `INSTANCES` | — | JSON `[{name,base,key,private?,entryPath?}]` per instance (the secret part) |
| `VIEW_TOKEN` | — | secret that unlocks private plaintext (unset ⇒ always locked) |
| `REFRESH_MS` | 600000 | cache TTL / browser refresh interval |
| `LIMIT` | 8000 | max entries pulled per instance (public is large) |
| `ME` | amiller | canonical handle to highlight |

`INSTANCES` is **not** committed — it's injected at deploy time from
`~/.claude/router-simulcast.json` (deploy.sh marks every instance private except
`public`, and sets `entryPath`). `VIEW_TOKEN` is generated once into
`~/.claude/router-dashboard-view-token` and reused; that file is the login token.

## Deploy
```bash
TEE_DAEMON_TOKEN=...  CVM=https://your-cvm.dstack.phala.network  bash deploy.sh
```
Reach it at `$CVM/router-dashboard/`. Re-run to redeploy. Promote to attested with the
daemon's normal `/_api/projects/router-dashboard/promote` once you're happy.

## Local dev
```bash
export INSTANCES='[{"name":"shaperotator","base":"https://…","key":"…"}, …]'
deno run --allow-net --allow-env server.ts   # → http://localhost:3000/
```

## Caveats
- The keys in `INSTANCES` are full-access user keys (read **and** write). They live on
  the CVM. If the Router ever offers read-only keys, swap them in here.
- feedling sits behind a bot filter; the server sends a browser User-Agent. If feedling
  blocks the CVM's egress IP anyway, its card shows the error and the other two still render.
- public's `/api/entries` ignores `?author=`, so the whole feed is pulled and tallied
  client-side; `LIMIT` must exceed its total entry count or counts undercount.
