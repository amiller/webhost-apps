# Registry

The local map of app → intended pod instance. The source of truth for *running* state is the CVM
itself (`GET /_api/projects`); this file is what the post-merge deploy lane reads to decide where a
merged static app goes (see `scripts/deploy-static.sh`).

| App | Runtime | Instances | Deploy | Live | Notes |
|---|---|---|---|---|---|
| router-dashboard | deno | hermes-staging | `deploy.sh` (needs `TEE_DAEMON_TOKEN`, `CVM`) | [✓ live](https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network/router-dashboard/) | Aggregates Router/simulcast feeds; secrets read from `~/.claude/router-simulcast.json` at deploy time. Per-app `deploy.sh`. |
| redteam-channel | — | — | — | — | **empty stub** (scanner/ + victim/ scaffolding, never built) |
| otterscope | deno | prod | tarball → `POST /_api/projects` | [✓ live](https://pod.dstack.soc1024.com/otterscope/) | Otter.ai transcript viewer via oauth3 `otter` plugin. **Extension-dependent** (`window.oauth3`) — needs the SDK extension-optional work to run on mobile/same-pod. |
| feedling-web | deno | prod | tarball → `POST /_api/projects` (Bearer `TEE_DAEMON_TOKEN`) | [✓ live](https://pod.dstack.soc1024.com/feedling-web/) | Doomscroll notifier; reads YouTube via oauth3 `youtube` plugin (user-approved token, NOT owner). Set `TZ`. Today-filtering blocked on per-item dates (oauth3-server). |
| calendar-share | deno | staging | `deploy.sh` → tarball `POST /_api/projects` (Bearer `TEE_DAEMON_TOKEN`); no app secrets | [✓ live](https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/calendar-share/) | **edit-on-behalf demo** (write-side sibling of `timeline-peek`). Owner mints a `write:event:<id>` share code; recipient edits ONE Google Calendar event. Thin `server.ts` serves `public/index.html` at `/calendar-share/`. Per-app `deploy.sh`. |
| reddit-karma | static | staging | tarball → `POST /_api/projects` (`scripts/deploy-static.sh`) | [✓ live](https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/reddit-karma/) | **sample OAuth3 app** for the app+plugin story. Connect → reads the Reddit account's karma through a scoped `reddit:read` token. Static `index.html`, same shape as `timeline-peek`. This is the app that motivated the post-merge deploy lane (it sat at 404 after merge until hand-deployed). |
| share-kit | static | staging | tarball → `POST /_api/projects` (`scripts/deploy-static.sh`) | [✓ live](https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/share-kit/) | **shared UI** for the suite: the journey-labeled Share button, capability receipt (link + TRUE scope sentence + Revoke + status pill), and recipient banner (honest end-states). `inline.sh` inlines the one file into an app's `index.html`. |
| timeline-peek | static | staging | tarball → `POST /_api/projects` (`scripts/deploy-static.sh`) | [✓ live](https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/timeline-peek/) | client-side twitter-feed relying-party demo; recovered from the running pod. Static `index.html`. |

## Instances legend

The `Instances` column uses aliases; `scripts/deploy-static.sh` resolves them. `staging` is the only
one with a daemon token on this box, so it is the only alias the static lane actually deploys to from
here — the others are listed for completeness and resolved as operator-run.

- `staging` — `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network` (the webhost-staging tee-daemon; token on this box via `~/.tee-daemon-staging.env`).
- `prod` — `https://pod.dstack.soc1024.com` (operator-run; no prod daemon token on this box, by design).
- `hermes-staging` — `https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network` (router-dashboard's home; operator-run).

## hermes-staging CVM (operator-run context)

- **Working URL:** `https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network` (app-id + port 8080, **prod7** gateway)
- ⚠️ The friendly CNAME `hermes-staging.dstack-pha-prod7.phala.network` is **broken** (TLS drops — custom-domain/cert not wired). Use the app-id URL.
- `TEE_DAEMON_TOKEN` is not stored in a file; it lives inline in tee-daemon session transcripts. Consider saving it to `~/.claude/tee-daemon-token` for cleaner future deploys.

_Live state: `curl $CVM/_api/projects -H "Authorization: Bearer $TEE_DAEMON_TOKEN"`_
