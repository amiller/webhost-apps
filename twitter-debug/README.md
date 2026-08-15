# OAuth3 debug console — Twitter as a case study

A self-contained webhost-app (`runtime: image`) for the [tee-daemon](https://pod.dstack.soc1024.com). It demonstrates the OAuth3 thesis on one site: **your session cookie, sealed inside a TEE, is a full capability** — and the browser is only needed *once*, to discover the shape of a request.

Live: `https://pod.dstack.soc1024.com/twitter-debug/` (trailing slash required).

## The thesis: one sealed jar, four rungs

The same intent (read your timeline, post a tweet) is served four ways, from most to least machinery:

| # | path | browser? | how it signs |
|---|------|----------|--------------|
| 1 | **blind API** (`rettiwt-api`) | no | guesses the request; on a datacenter/VPN egress X rejects it before GraphQL |
| 2 | **browser observe** (Brave + xdotool + X11 + GLM-4.5V vision, in-TEE) | yes | drives the real page; the request is signed by X's own JS |
| 3 | **reify = replay** | no | replay the browser-observed request headlessly (plain `fetch`) |
| 4 | **headless engine** | no | build the request from scratch: jar + queryId (from X's JS bundle) + feature flags |

The point of the console is the **instrumentation** — putting these side by side shows exactly where each one succeeds or fails.

### Key finding: X's `x-client-transaction-id` is not enforced here

We spent effort capturing the `x-client-transaction-id` (xctid) the browser sends, assuming it was the gate. It isn't — on an **authenticated** session, X does not validate it for these endpoints:

- `HomeTimeline` (read): valid / **absent** / **garbage** xctid → all `200`.
- `FavoriteTweet` / `CreateTweet` (writes): **garbage** xctid → succeeds (`"favorite_tweet":"Done"`, real tweet created).

So the whole surface reduces to rung 4. You need only:

- `auth_token` + `ct0` cookies (the latter is also the `x-csrf-token`),
- the graphql **queryId** — grep'd live from `https://abs.twimg.com/responsive-web/client-web/main.<hash>.js` (`queryId:"…",operationName:"…"`), so it self-updates,
- the operation's **feature flags** (baked in `server.ts`).

The xctid is a bot-detection signal aimed mostly at the *guest/unauthenticated* surface. (If you ever need it for that surface, the generation inputs are all fetchable headlessly too: the `twitter-site-verification` meta, the four `loading-x-anim` SVG frames, and the byte indices in `ondemand.s.<hash>.js`.)

## Endpoints (served by `ws-bridge.js` on the single `image_port` 3000, proxied to the agent on 8090)

Reads/observation are **public**. Writes (post/like/unlike) and the mouse-probe require the owner's **OAuth3 consent** (Connect X on the dashboard → approve in the OAuth3 popup, which discloses the raw-jar grant). Browser-driving is lock+cooldown'd so the single in-TEE browser can't be hogged.

| endpoint | gate | notes |
|----------|------|-------|
| `GET /twitter/health` `/twitter/status` `/twitter/shot` `/twitter/ip` `/twitter/cookies` | public | observe: health, what's holding the browser, live frame, egress IP, loaded cookie names |
| `POST /twitter/oauth3/connect` · `GET /twitter/oauth3/status` · `POST /twitter/oauth3/refresh` | public | delegated-jar connect (`caps: ["jar","write"]`); once the owner approves, the jar is pulled from their vault and writes unlock |
| `POST /twitter/api {op}` | timeline public; post/like/unlike consent | blind `rettiwt-api` path |
| `POST /twitter/browser {task}` | trace public (lock+cooldown); post consent | drive the real browser (vision + xdotool), verified against the CDP trace |
| `POST /twitter/reify` | public (lock+cooldown) | rung 1 vs 2 vs 3 side-by-side + diff + verdict |
| `POST /twitter/engine {op}` | timeline public; post/like/unlike consent | **rung 4 — fully headless, no browser, no xctid**; `timeline` maps tweets with `media[]` |
| `POST /twitter/feed` | public (lock+cooldown) | #6 — the reify payoff as a feed: browser-observed HomeTimeline replayed headlessly, mapped to tweets each carrying `media[]` `{type:'photo'\|'video', url}` (videos: best-bitrate mp4 + poster) |
| `GET /twitter/media?u=<b64url>` | public | #6 — same-origin media relay (the otter `/frame` pattern): `*.twimg.com` only, https only, Range pass-through. The dashboard renders ALL media (avatars included) through it, so the page makes zero direct twimg.com requests |
| `POST /twitter/probe` | consent | xdotool diagnostics (geometry, mouse) |

## Security model

Public URL → **read-only by default**:

- Writes (`post`, `like`, `unlike`) and the probe are gated on the owner's OAuth3 consent. The dashboard's **Connect X via OAuth3** button starts a delegated-jar connect (`caps: ["jar","write"]`); the owner approves in the OAuth3 popup, which discloses that this enclave receives the **raw twitter session cookies**. Once approved, the jar is pulled from the vault and writes unlock. Not connected → writes hard-disabled.
- The dashboard pill shows `🔒 read-only` / `🔓 writes on` and reflects the live OAuth3 connection state — there is no shared secret and no per-request header; the consent IS the gate.
- Browser-driving (`browser`, `reify`) has a single-flight lock + 20s cooldown so nobody can monopolize the one browser.

The consent is revocable from the OAuth3 node at any time. There is **no `DEBUG_SECRET` / shared-secret path** — it was removed in favor of the consent flow.

## Deploy

Prereqs: `docker`, a `TEE_DAEMON_TOKEN`, a `ZAI_API_KEY` (GLM-4.5V, z.ai coding/paas endpoint), and — for the attested VPN egress — ProtonVPN creds in `secrets.env`.

```bash
# attested: caps:[NET_ADMIN] → the baked-in vpn.sh brings up a full-tunnel ProtonVPN egress
ZAI_API_KEY=… ./deploy-attested.sh          # posts the image manifest to the daemon

# load the jar (consent): open the dashboard → Connect X via OAuth3 → approve in the popup.
# the raw jar (incl. httpOnly auth_token) is pulled from your OAuth3 vault and sealed in the TEE.
```

`deploy.sh` is the non-attested variant (no VPN, no NET_ADMIN). The OAuth3 token is persisted to the `/data` volume, so the jar re-sources itself on container restart — no re-approve, no re-upload.

### Attested privilege

`NET_ADMIN` + `/dev/net/tun` are granted by the tee-daemon **only when `mode: attested`** (opaque/dev containers can't get them). That's what lets `vpn.sh` bring up a full-tunnel ProtonVPN egress inside the enclave.

## Layout

- `server.ts` — the agent (data hub). All four paths + the reify diff + the headless engine + status/visibility.
- `human-mouse.ts` — xdotool input (ghost-cursor bezier moves, per-char typing, `Ctrl+Enter` submit).
- `glm-vision.ts` — GLM-4.5V locate/classify (normalized-1000 coords).
- `extension/` — the Envoy Chrome extension: CDP network-trace capture (`startTrace`/`captureTrace`), cookie injection, and `rectOf(selector)` for exact DOM rects.
- `ws-bridge.js` — serves the dashboard + relays tool commands to the extension.
- `web/index.html` — the dashboard.
- `Dockerfile` — neko/brave base + node + xdotool/x11vnc/openvpn + the above. Deps install in a cached layer and source is a tiny top layer, so editing `server.ts`/`web/` is a ~1s rebuild.

## Notes / limits

- Browser **posting** works via `Ctrl+Enter` (X's shortcut): in this container XTEST *clicks* focus inputs but don't fire X's React Post button, while keyboard input does. Coordinates/vision/typing are all correct — see `server.ts` `runBrowser` and the git history for the diagnosis.
- The **engine** is the reliable write path (rung 4); the browser path is the ground-truth observer and the tool for sites that *do* enforce signing.
- One image (~1.85 GB, neko/brave). The jar and all secrets are read from env / external files — none are baked into the image.
