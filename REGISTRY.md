# Registry

The local map of app → intended pod instance, AND the source of truth for the live-evidence walk.
The source of truth for *running* state is the CVM itself (`GET /_api/projects`); this file is what
the post-merge lanes read:

- **deploy lane** — `scripts/deploy-static.sh` reads `Instances` to decide where a merged static
  app goes.
- **evidence lane** — `scripts/registry-evidence.sh` reads `Evidence URL` + `Expected` to decide
  which apps the screenshot/PASS-FAIL gate drives, and what "working" looks like for each. A new
  app PR that adds its row here is thereby self-registering into the gate — **zero host-side edits**
  (issue #41). The zed-side `apps-evidence.sh` consumes that script's output instead of a hardcoded
  list.

| App | Runtime | Instances | Deploy | Live | Evidence URL | Expected | Notes |
|---|---|---|---|---|---|---|---|
| router-dashboard | deno | hermes-staging | `deploy.sh` (needs `TEE_DAEMON_TOKEN`, `CVM`) | [✓ live](https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network/router-dashboard/) | https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network/router-dashboard/ | `title "Router Member Dashboard"` | Aggregates Router/simulcast feeds; secrets read from `~/.claude/router-simulcast.json` at deploy time. Per-app `deploy.sh`. |
| redteam-channel | — | — | — | — | — | — | **empty stub** (scanner/ + victim/ scaffolding, never built) |
| otterscope | deno | prod | tarball → `POST /_api/projects` | [✓ live](https://pod.dstack.soc1024.com/otterscope/) | https://pod.dstack.soc1024.com/otterscope/ | `title "Otter via OAuth3"` | Otter.ai transcript viewer via oauth3 `otter` plugin. SDK `connect()` (RFC 0008): extension provider-preferred, web-approve fallback via the signed-in pod room — works mobile/same-pod. |
| feedling-web | deno | prod | tarball → `POST /_api/projects` (Bearer `TEE_DAEMON_TOKEN`) | [✓ live](https://pod.dstack.soc1024.com/feedling-web/) | https://pod.dstack.soc1024.com/feedling-web/ | `title "feedling"` | Doomscroll notifier; reads YouTube via oauth3 `youtube` plugin (user-approved token, NOT owner). Set `TZ`. Today-filtering blocked on per-item dates (oauth3-server). |
| calendar-share | deno | staging | `deploy.sh` → tarball `POST /_api/projects` (Bearer `TEE_DAEMON_TOKEN`); no app secrets | [✓ live](https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/calendar-share/) | https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/calendar-share/ | `title "Calendar Share"` | **edit-on-behalf demo** (write-side sibling of `timeline-peek`). Owner mints a `write:event:<id>` share code; recipient edits ONE Google Calendar event. Thin `server.ts` serves `public/index.html` at `/calendar-share/`. Per-app `deploy.sh`. |
| reddit-karma | static | staging | tarball → `POST /_api/projects` (`scripts/deploy-static.sh`) | [✓ live](https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/reddit-karma/) | https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/reddit-karma/ | `title "Reddit Saved"` | **sample OAuth3 app** for the app+plugin story. Connect → reads the Reddit account's **saved posts** through a scoped `reddit:read` token (`GET /oauth3/api/reddit/items`; the `/account` karma route was never shipped and 404s — #64). Static `index.html`, rendered title `Reddit Saved`; same shape as `timeline-peek`. Motivated the post-merge deploy lane (sat at 404 after merge until hand-deployed). |
| share-kit | static | staging | tarball → `POST /_api/projects` (`scripts/deploy-static.sh`) | [✓ live](https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/share-kit/) | https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/share-kit/ | `title "share-kit"` | **shared UI** for the suite: the journey-labeled Share button, capability receipt (link + TRUE scope sentence + Revoke + status pill), and recipient banner (honest end-states). `inline.sh` inlines the one file into an app's `index.html`. |
| timeline-peek | static | staging | tarball → `POST /_api/projects` (`scripts/deploy-static.sh`) | [✓ live](https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/timeline-peek/) | https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/timeline-peek/ | `title "Timeline Peek"` | client-side twitter-feed relying-party demo; recovered from the running pod. Static `index.html`. |
| zai-usage | static | staging | tarball → `POST /_api/projects` (`scripts/deploy-static.sh`) | [✓ live](https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/zai-usage/) | https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/zai-usage/ | `title "GLM Usage"` | **z.ai Coding Plan usage app** (issue #76). Reads GLM quotas through a scoped `zai:usage-read` token via the `zai` cookie-jar plugin (oauth3-server, pending). Static `index.html`, uses the shared `ShareKit.oauth3Connect` helper. Render path proven with a labeled SAMPLE until the plugin + owner jar-sync land. |
| goodpoint-box | deno | staging | `deploy.sh` → tarball `POST /_api/projects` (Bearer `TEE_DAEMON_TOKEN`); requires `OAUTH3_CORE`, `OTTER_TOKEN`, `NEAR_API_KEY`, `CHUTES_API_KEY` | ☐ pending deploy (issue #80) | https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/goodpoint-box/app | `title "goodpoint-box"` | Live Otter transcript + good-point detector steering the interleave brainrot canvas. No mic/STT path and no demo data path. |
| screenshare-debug | deno | staging | `deploy.sh` → tarball `POST /_api/projects` (Bearer `TEE_DAEMON_TOKEN`); no app secrets for echo-sink | ☐ pending deploy (lane #39) | https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/ | `title "screenshare-debug — screen → pod under consent"` | **screen-stream consent demo** (aishley sibling of feedling / timeline-peek). Capture → scoped, revocable grant → debug echo-sink (proof of delivery) or aishley enclave. oauth3 = identity + grant trust root, never in the frame path. Desktop-only (`getDisplayMedia`). |
| screenshare-pet | deno | staging | `deploy.sh` → tarball `POST /_api/projects` (Bearer `TEE_DAEMON_TOKEN`); no app secrets | ☐ pending deploy | https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-pet/ | `title "screenshare-pet — a PiP pet that watches your screen"` | **change-signals demo consumer** (sibling of screenshare-debug, issue #73). Picture-in-Picture pet reactive to signals derived from the screen (`changedPct` + hot region + `still`/`local`/`scene`), with rare budgeted OCR/VLM escalation. **All auth machinery out; frames never leave the browser** unless the dev-only mirror toggle is on. Desktop-only (`getDisplayMedia`); in-page fallback where Document PiP is unavailable. |
| souk-dogfood | python | prod | `deploy.sh` (needs `CVM`, `TEE_DAEMON_TOKEN`, `SOUK_LLM_KEY`, `SOUK_ROOT_TOKEN`) | [✓ live](https://pod.dstack.soc1024.com/souk-dogfood/) | https://pod.dstack.soc1024.com/souk-dogfood/board | `#souk "souk-dogfood"` | **souk-mini run as a posted service** — a group pools private evidence and the protocol kernel settles who gets paid. `/board` is the group view (public tier without a token), `/debug` the operator view with a tier cut-line. Signal is a **selector, not `title`**: the title is static markup and would green on a dead API, whereas `#souk` is filled from `GET /api/board`, so it greens only if the app answered. Source is **not** in this repo — `sxysun/souk`, branch `amiller-notes`, `amiller-notes/dogfood/` — so the daemon record carries `source: ""` and it is not promotable. State lives on `/daemon-data/souk-dogfood/` and survives redeploy (verified 2026-08-09). |

## Evidence walk contract (#41)

`Evidence URL` is the absolute URL the screenshot browser navigates to — staging OR prod, independent
of the deploy `Instances` alias. `Expected` is the exact content signal the page must render for the
card to go green; `—` in either column means the app is skipped by the evidence walk (screenshotted
cards require both).

### Signal grammar (the `Expected` cell)

Both forms end with a double-quoted expected string. The leading token selects what is read:

| Form | Meaning |
|---|---|
| `` title "<text>" `` | PASS iff `document.title.trim() === "<text>"` |
| `` <css-selector> "<text>" `` | PASS iff `document.querySelector("<css-selector>")?.textContent.trim() === "<text>"` |

`title` is the default and matches what the gate has always asserted (an exact document.title). The
selector form lets a row pin a signal deeper than the title when a title is generic or shared. Any
other value / empty / `—` ⇒ no signal ⇒ the card never greens (FAIL by default), so never put a fake
or aspirational signal here — only one verified against the live page.

### Who reads this

`scripts/registry-evidence.sh rows` parses this table (from `origin/staging` by default, so a freshly
merged app row self-registers) and emits one pipe-row per app that has both `Evidence URL` and
`Expected`: `app|url|signal|caption|issue`. The zed-side `apps-evidence.sh` replaces its hardcoded
5-app array with that output and evaluates the signal grammar in the browser (reference JS in
`scripts/registry-evidence.sh`'s header). That swap is the second half of #41 and is operator-run.

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
