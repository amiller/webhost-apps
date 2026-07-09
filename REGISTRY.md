# Registry

| App | Runtime | Deploy | Live | Notes |
|---|---|---|---|---|
| router-dashboard | deno | `deploy.sh` (needs `TEE_DAEMON_TOKEN`, `CVM`) | [✓ live](https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network/router-dashboard/) | Aggregates Router/simulcast feeds; secrets read from `~/.claude/router-simulcast.json` at deploy time |
| redteam-channel | — | — | — | **empty stub** (scanner/ + victim/ scaffolding, never built) |
| otterscope | deno | tarball → `POST /_api/projects` | [✓ live](https://pod.dstack.soc1024.com/otterscope/) | Otter.ai transcript viewer via oauth3 `otter` plugin. **Extension-dependent** (`window.oauth3`) — needs the SDK extension-optional work to run on mobile/same-pod. |
| feedling-web | deno | tarball → `POST /_api/projects` (Bearer `TEE_DAEMON_TOKEN`) | [✓ live](https://pod.dstack.soc1024.com/feedling-web/) | Doomscroll notifier; reads YouTube via oauth3 `youtube` plugin (user-approved token, NOT owner). Set `TZ`. Today-filtering blocked on per-item dates (oauth3-server). |
| calendar-share | deno | `deploy.sh` → tarball `POST /_api/projects` (Bearer `TEE_DAEMON_TOKEN`); no app secrets | [✓ static-serving live on staging](https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/calendar-share/) | **edit-on-behalf demo** (write-side sibling of `timeline-peek`). Owner mints a `write:event:<id>` share code; recipient edits ONE Google Calendar event. Thin `server.ts` serves `public/index.html` at `/calendar-share/` (`<base href>` pins relative fetches); no owner token server-side. Depends on oauth3-server#69 (shipped to prod 2026-07-07); live mint→edit→reject runs against prod + the synced cube@ jar (operator-run). |
| reddit-karma | — | tarball → `POST /_api/projects` (static) | — | **sample OAuth3 app** for the app+plugin story. Connect → reads the Reddit account's karma (total + comment/link) through a scoped `reddit:read` token. Consumes oauth3-server#83 (open); built against a clearly-labelled mock until the plugin lands, real errors surfaced in an evidence block. Static `index.html`, same shape as `timeline-peek`. |
| share-kit | — | tarball → `POST /_api/projects` (static) | [✓ live](https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/share-kit/) | **shared UI** for the suite: the journey-labeled Share button, capability receipt (link + TRUE scope sentence + Revoke + status pill), and recipient banner (honest end-states). Consumes each app's pod tokens. First adopted by `timeline-peek`; `calendar-share`/`otterpilot` to follow. `inline.sh` inlines the one file into an app's `index.html`. |

## hermes-staging CVM (where these deploy)

- **Working URL:** `https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network` (app-id + port 8080, **prod7** gateway)
- ⚠️ The friendly CNAME `hermes-staging.dstack-pha-prod7.phala.network` is **broken** (TLS drops — custom-domain/cert not wired). Use the app-id URL.
- `TEE_DAEMON_TOKEN` is not stored in a file; it lives inline in tee-daemon session transcripts. Consider saving it to `~/.claude/tee-daemon-token` for cleaner future deploys.

_Live state: `curl $CVM/_api/projects -H "Authorization: Bearer $TEE_DAEMON_TOKEN"`_
