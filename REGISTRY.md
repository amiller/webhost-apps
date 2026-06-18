# Registry

| App | Runtime | Deploy | Notes |
|---|---|---|---|
| router-dashboard | deno | `deploy.sh` (needs `TEE_DAEMON_TOKEN`, `CVM`) | Aggregates Router/simulcast feeds; secrets read from `~/.claude/router-simulcast.json` at deploy time |

_Live state: `curl $CVM/_api/projects -H "Authorization: Bearer $TEE_DAEMON_TOKEN"`_
