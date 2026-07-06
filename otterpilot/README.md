# otterpilot

Follow a **live** Otter meeting — transcript feed, the shared-screen slides, and a
**"what were we talking about?"** button that recaps the last minute or two (grounded on
the current slide via a vision model when one's on screen).

Deno app, deployed as a tee-daemon project on the pod. Live: `https://pod.dstack.soc1024.com/otterpilot/`

Ported from `teleport/planning/scripts/otter_web` (`server.py`), which ran on your laptop and
read the raw Otter session cookie straight out of local Chrome. This version has no browser
and holds no cookie: the meeting feed and every slide frame come **through the oauth3 node
over a scoped, revocable token** (the `otter` plugin's `/live` + `/frame` endpoints). The
token stays server-side — the browser only ever talks to otterpilot.

## Not extension-dependent
Unlike `otterscope` (which needs `window.oauth3.connect` from the browser extension), otterpilot
runs headless: its token is **owner-minted** and set as `OAUTH3_TOKEN`. Works from a phone, no
extension.

## What it needs on the oauth3 side
The `otter` plugin gained two live-follow endpoints (in `oauth3-server`, same read scope as `/items`):

- `GET /api/otter/live[?after=N]` — the currently-live speech's recent transcript segments
  (keyed by `order` for incremental polling) + the last few shared-screen frame urls.
- `GET /api/otter/frame?u=<base64url(image_url)>` — proxy one slide image from Otter's CDN
  (only `*.aisense.com` is reachable, so a stray url can't become an SSRF).

Both require the oauth3 node to be up and your Otter jar sealed/synced into it (otherwise
they 409 `no jar synced` / "not logged in", same as otterscope).

## Env
- `OAUTH3_NODE` — the pod's oauth3 instance (default `https://pod.dstack.soc1024.com/oauth3`).
- `OAUTH3_TOKEN` — owner-minted, otter-scoped token (secret; injected at deploy).
- `NEAR_KEY` — NEAR AI Cloud key, the recap engine (secret; injected at deploy).
- `NEAR_MODEL` / `NEAR_VL_MODEL` — text + vision models (defaults set).

## Mint the token
Once the oauth3 node is healthy, mint an otter-scoped read token as owner and drop it in the
file `deploy.sh` reads:

```bash
NODE=https://pod.dstack.soc1024.com/oauth3
OWNER=$OAUTH3_OWNER_SECRET   # the node's owner secret
curl -s -X POST "$NODE/api/tokens" \
  -H "Authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d '{"plugin":"otter","subject":"owner"}' | tee /dev/stderr \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' \
  > ~/.claude/otterpilot-oauth3-token
```

Revoke anytime with `DELETE /api/tokens/:token` — that kills otterpilot's access without
touching the sealed cookie.

## Deploy
`bash deploy.sh` — tarballs `server.ts` + `project.json` + `public/`, POSTs to the daemon
(`POST /_api/projects`, Bearer `TEE_DAEMON_TOKEN`), env carries the two secrets. Redeploy = re-run.
