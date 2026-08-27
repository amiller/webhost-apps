# Flow evidence — issue #153 (mirrors amiller/oauth3-apps#23): timeline-peek node routing

Deployed: `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/timeline-peek/`
(branch `ready-153`, deployed via `scripts/deploy-static.sh timeline-peek --ref HEAD`, tree f055b931c289).
Driven through the zed envoy bridge (real Brave + oauth3 extension), 2026-08-27. Every step asserts
`location.href` before trusting evaluate/screenshot; screenshots verified non-blank and pairwise pixel-different.

## Acceptance assertions

### 1. `?node=<url>` routes the app to a different instance than its own origin — PROVEN (02)

- URL: `…/timeline-peek/?node=https%3A%2F%2F127.0.0.1%3A9%2Foauth3&token=tok-153-probe`
- `evaluate("NODE")` → `https://127.0.0.1:9/oauth3` (the override, NOT the page origin)
- The shared-mode read ran against that node and rendered the real in-page error:
  note = `couldn't reach the oauth3 node (Failed to fetch)`, class `note err`
- Screenshot: `02-node-override-read-goes-to-override.png`

Also verified with a live second instance: `?node=https://pod.dstack.soc1024.com/oauth3` →
`evaluate("NODE")` = `https://pod.dstack.soc1024.com/oauth3`.

### 2. Without `?node=`, node derived mount-aware (no origin-rooted hardcode) — PROVEN (01)

- URL: `…/timeline-peek/` (no params)
- `evaluate("NODE")` → `<origin>/oauth3`, i.e. `location.pathname` `/timeline-peek/` stripped,
  `/oauth3` sibling appended — identical result to the old hardcode on this mount, so default
  behavior is unchanged; a prefixed mount (`/pod/timeline-peek/`) resolves to `/pod/oauth3` by
  the same strip.
- Screenshot: `01-no-override-landing.png`

### 3. Shared mode (`?token=…`) unchanged — PROVEN (03)

- URL: `…/timeline-peek/?token=tok-153-probe` (no `node`)
- note = `unauthorized` — a real HTTP answer from the own-origin staging node (contrast 02: same
  code path, override only difference → network failure). No crash, honest error state.
- Screenshot: `03-shared-mode-unchanged.png`

### Owner-mode connect still reaches the live node (04)

- No params, clicked `#go` → note = `Asking your wallet for a scoped twitter token…` (extension
  path; the approval popup is browser chrome, not captured — see below).
- Screenshot: `04-owner-connect-live-node.png`

## What was NOT verified

- A green signed-in feed: the twitter backend (browser-SPI) is down on staging (noted in the file
  itself), and connect UX/mobile is owned by teleport-computer/oauth3-server#55 — explicitly not
  an acceptance gate for this issue.
- The extension approval popup surface (browser chrome; page-DOM screenshots cannot show it).
- A prefixed-mount deployment (`/pod/timeline-peek/`) is not deployable on this staging instance;
  that case exercises the same `replace(/\/timeline-peek\/?$/, "")` line proven in step 2.
