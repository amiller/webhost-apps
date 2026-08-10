# Registry

| App | Runtime | Deploy | Live | Notes |
|---|---|---|---|---|
| router-dashboard | deno | `deploy.sh` (needs `TEE_DAEMON_TOKEN`, `CVM`) | [✓ live](https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network/router-dashboard/) | Aggregates Router/simulcast feeds; secrets read from `~/.claude/router-simulcast.json` at deploy time |
| redteam-channel | — | — | — | **empty stub** (scanner/ + victim/ scaffolding, never built) |
| otterscope | deno | tarball → `POST /_api/projects` | [✓ live](https://pod.dstack.soc1024.com/otterscope/) | Otter.ai transcript viewer via oauth3 `otter` plugin. **Extension-dependent** (`window.oauth3`) — needs the SDK extension-optional work to run on mobile/same-pod. |
| feedling-web | deno | tarball → `POST /_api/projects` (Bearer `TEE_DAEMON_TOKEN`) | [✓ live](https://pod.dstack.soc1024.com/feedling-web/) | Doomscroll notifier; reads YouTube via oauth3 `youtube` plugin (user-approved token, NOT owner). Set `TZ`. Today-filtering blocked on per-item dates (oauth3-server). |
| attest-proxy | deno | prod | from source: [amiller/attest-proxy](https://github.com/amiller/attest-proxy) | [✓ live](https://pod.dstack.soc1024.com/attest-proxy/) | https://pod.dstack.soc1024.com/attest-proxy/ | `title "attest-proxy — witnessed agent sessions"` | Witnessed agent sessions: holds the API key, commits to every call, signs a Merkle root. Client `attest.py` + agent skill `skill-attest.md`. **dev mode** — promote for TDX quotes. Session creation gated by an invite token. |

## hermes-staging CVM (where these deploy)

- **Working URL:** `https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network` (app-id + port 8080, **prod7** gateway)
- ⚠️ The friendly CNAME `hermes-staging.dstack-pha-prod7.phala.network` is **broken** (TLS drops — custom-domain/cert not wired). Use the app-id URL.
- `TEE_DAEMON_TOKEN` is not stored in a file; it lives inline in tee-daemon session transcripts. Consider saving it to `~/.claude/tee-daemon-token` for cleaner future deploys.

_Live state: `curl $CVM/_api/projects -H "Authorization: Bearer $TEE_DAEMON_TOKEN"`_
