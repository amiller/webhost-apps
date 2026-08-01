# Flow — issue #72 compute panel (PR #101), Tier 2 walked on deployed staging

**When:** 2026-08-01. **Rig:** envoy/neko bridge at `localhost:3000` (real Brave, real
pointer/keyboard, **no CDP/Playwright** — per LESSONS). **Target (deployed staging):**
`https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/`

## Acceptance under test (the verifiable subset of #72 this PR ships)
Re-stated from the issue's `## Acceptance`:
1. **Stats card shows per-stage ms, duty-cycle %, bytes/frame, bytes/min, live while streaming.**
2. **Encoding comparison renders a JPEG/WebP/PNG bytes+ms table for a real frame.**

(The tile-delta / delta-bandwidth / reassembly-failure criteria are **deferred to #71** — they need
the change-detection foundation, absent from `staging`; PR #100 carries it. Not asserted here.)

## How the deployed page came to be PR #101's code (honesty note)
`staging`'s `screenshare-debug/public/index.html` is the **old** version (compute panel absent); the
live CVM mount at `/screenshare-debug/` was carrying **#100's** (ready-71) "change detection" deploy.
To walk PR #101 on *deployed staging* without permanently displacing #100 (which is `ready-to-merge`
and was deployed 2026-08-01 19:55Z), this lane:
1. deployed `ready-72` (PR #101) to the staging CVM project `screenshare-debug` (20:57:56Z, tree
   `a5653cc8e1e1`) — the project the gate-walk and #100 both target,
2. ran the walk below against that URL,
3. **restored #100's deploy** verbatim (20:59:00Z, tree `48e4654aa91d` — byte-identical to the
   pre-walk mount; verified: title reverted to `screenshare-debug · change detection`, compute-panel
   markers gone).

Net effect on shared infra: **none** (end state == start state). The screenshots below are the
ready-72 page served from the real staging CVM URL, driven through the real browser.

> The two blockers cited in the PR's first iteration are **resolved**, not worked around:
> - *"envoy bridge `wsClients:0`"* was a **misdiagnosis**. The bridge's `/health` `wsClients` field
>   counts WebSocket clients, but the extension polls commands over HTTP (`GET /api/commands` /
>   `POST /api/responses`). The rig is functional: a live `navigate`→`evaluate`→`screenshot` returns
>   real bytes (see `bridge-health.txt`).
> - *"`/screenshare-debug/` on staging is not serving"* was a transient daemon state; it now serves
>   (HTTP 200, real title). See `reverification.txt`.

## Walk (driven via the bridge; `location.href` asserted before each shot — LESSON "verify navigation")

1. `navigate` → `/screenshare-debug/`. Asserted `location.href` === the staging URL. Title rendered:
   `screenshare-debug · oauth3` (ready-72). Bridge sees `window.__ssdebug` = `{demo,revoke,compare,state}`
   (page main-world reachable).
2. `__ssdebug.demo()` — mints a session `did:key`, `POST /consent/grant` → capability pill reads
   **"capability live · 4fps · 1800s"** (this app's auth model is per-session did:key UCAN, so
   "signed in" = "capability live"; there is no oauth3 user-login for this app). Begins streaming the
   **synthetic moving-rect source** — the headless-safe harness issue #72 itself specifies ("Local
   harness … synthetic source (moving rect)"). `getDisplayMedia` cannot capture a screen in the
   headless container; the synthetic source is the spec-sanctioned substitute and is used identically
   on local or CVM serve, so "deployed staging" adds no fidelity here.
3. After ~10 ticks (EMA settle), captured `__ssdebug.state()` → `state-after-stream.json`:
   `seq=10, acc=9, rej=0, fullFrames=9, emaDraw=0.2ms, emaEnc=3.0ms, emaPost=90.4ms,
   lastTickMs=92.3ms, dutyCycle=15.38%, emaBytes=1714 B/frame, bytesPerMin=171373 B (~167 KB/min)`.
   → **`01-cost-panel-live.png`** (146 398 B, 1912×943, distinct-color check = 2766 → non-blank).
4. `__ssdebug.compare()` — encodes the current canvas as JPEG/WebP/PNG off one snapshot. Rendered
   `#encRows` DOM text:
   `JPEG q0.6 1715 5.2 100% | WebP q0.6 1212 10.1 71% | PNG 8613 4.7 502% | AVIF N/A — canvas.toBlob
   has no AVIF encoder`. Raw dump → `enc-rows.json`.
   → **`02-encoding-comparison.png`** (147 797 B, distinct-color = 2785 → non-blank).
5. **`03-page-overview.png`** — full page, top scrolled (147 838 B, distinct-color = 2788 → non-blank).

## Verdict
- **Acceptance 1 (live cost panel): MET.** draw/encode/post ms, duty-cycle %, bytes/frame, bytes/min
  all render with real, updating values while streaming; the `diff` row renders `n/a — pending #71`
  exactly as the PR scopes it.
- **Acceptance 2 (encoding comparison): MET.** JPEG/WebP/PNG bytes+ms table for one real frame;
  WebP feature-detected (supported here), AVIF honestly `N/A` (no canvas encoder), nothing silently
  skipped.

## What I could NOT verify
- This agent cannot render images, so the screenshots were verified by **DOM textContent assertions**
  (the exact values above) + a **non-blank pixel check** (distinct-color count) on each PNG, not by
  eye. The human reviewer visually confirms via the images embedded in the PR body.
- The tile-delta / reassembly criteria (#71) — out of scope for this PR by design.

## Drive-by fix included
`screenshare-debug/deploy.sh` tar line added `ucan.ts` (`server.ts` imports `./ucan.ts`; without it
`bash deploy.sh` ships a broken app that can't resolve the import). This is a pre-existing staging
bug (present at the merge-base); #100 fixed it independently with the identical one-token edit, so
this merges cleanly with #100 and is necessary for this PR to deploy at all.
