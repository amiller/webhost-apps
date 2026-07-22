# Flow evidence — issue #76 (zai-usage app)

**App:** `zai-usage` (static `index.html`). **Deployed URL (staging):**
`https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/zai-usage/`
**Commit:** `e8c5f99` (deploy tree `8ab5cef816ab`). **Driven:** real envoy/neko Brave (with the oauth3
extension loaded) via the bridge, serialized with `flock /tmp/envoy-bridge.lock`.
**Evidence tier: Tier 2 (user-visible).** This is the **scope-down subset** — see "Not verified" below.

## Acceptance (from issue #76) and how each line is met

> *Owner connects the z.ai session via extension jar-sync; opening the zai-usage app shows the SAME
> quota percentages as the z.ai dashboard (live, owner-verified, real data).*

- The **live value-state is NOT achievable in this repo**: it needs (a) the `zai` cookie-jar plugin
  in **oauth3-server** (`server/plugins/zai.ts`), which does **not exist yet** — verified live:
  `GET /oauth3/api/health` → plugins = `otter, youtube, reddit, nytimes, twitter, google-calendar,
  amazon` (no `zai`); and (b) the owner's real z.ai session synced under jar key `zai_token`.
  Both are commented back on the issue as the remaining steps.
- The **render path IS proven** with a clearly-labeled SAMPLE (not live data). Clicking "Preview
  sample render" produces exactly the dashboard's headline shape — asserted via `evaluate()`:
  - stamp = `sample · not live`
  - cards = `3% used` (5-hour), `32% used` (weekly), `291.0M` (tokens / 7d), `142 / 500` (search/reader)
  - models = `GLM-4.6 198.0M`, `GLM-4.5-Air 71.0M`, `GLM-4.5V 22.0M`
  - The sample carries an explicit "SAMPLE — not live data. Proves the render path only." note.
  These mirror the issue's captured dashboard ("5h 3%, weekly 32%, 291M tokens / 7d").

> *JSON endpoint returns the quota numbers for machine use; with no jar, honest "connect z.ai" state.*

- The JSON endpoint **is** the plugin route `GET /oauth3/api/zai/quota` (oauth3-server) — the contract
  is written into this app's header comment, README, and PR body for the oauth3-server side.
- **Honest "connect z.ai" state — verified live on the deployed page**: the diagnostics line reads
  `build b1 · instance: reachable · zai plugin not registered (oauth3-server zai plugin pending —
  see issue #76) · extension present`. Nothing is faked; the real missing-plugin state is shown.

## Steps walked (screenshots in this dir)
1. `01-landing.png` — deployed landing page. `location.href` + `document.title === "GLM Usage"`
   asserted after navigate (navigation verified, not just captured). Shows the scoped
   `zai:usage-read` pill, Connect + "Preview sample render" buttons, and the REAL diagnostics line.
2. `02-sample-render.png` — "Preview sample render" clicked; the quota grid renders with the
   `sample · not live` stamp and the explicit not-live-data note. Render path proven.
3. `03-connect-state.png` — Connect clicked; page enters `Asking your wallet for a scoped zai
   token…` (the shared `ShareKit.oauth3Connect` helper fired `window.oauth3.connect({plugin:"zai"})`).
   See "Not verified" for why this didn't reach a terminal state.

## NOT verified (honest)
- **Live quota numbers**: needs the oauth3-server `zai` plugin + owner z.ai jar-sync (neither in
  this repo). Proven by SAMPLE render only.
- **Connect → approve → terminal read result**: `ShareKit.oauth3Connect` correctly initiates and
  opens the wallet's connect/approve **popup**, which is browser chrome — the bridge drives page DOM,
  not extension popups (Constitution: extension-mediated flows can't be proven by page-DOM automation).
  The page stayed in the honest "Asking your wallet…" state; I did not fake an approval or an error.
  Once the `zai` plugin ships, a step-up 409 is handled by the helper's poll loop (proven in #66/#68),
  and a terminal failure renders via `renderError` (code path parse-checked, symmetric with the
  SAMPLE-proven `renderQuota`).

## Verdict
The app half of #76 is complete and deployed: it renders the quota cards correctly (SAMPLE-proven),
connects through the shared helper, and shows the REAL state honestly (zai plugin not registered).
The remaining work is the cross-repo `zai` plugin (oauth3-server) + owner jar-sync — commented on
the issue with the exact interface contract.
