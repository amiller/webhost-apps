# Issue #9 — verification record (functional proof on deployed staging; rendered screenshots externally blocked)

## What this fixes (the regression)
#9's no-extension wallet sign-in path — shipped in PR #10 (commit `d69dc6a`, 2026-07-06) — was
**lost**: later redesigns (#48 "mirror x.com" feed, #25/#31 share panel) rewrote
`timeline-peek/index.html` and reverted to the old **"No OAuth3 wallet found — install the oauth3
extension and reload."** dead-end. So the phone dead-end #9 fixed was back on `origin/staging`
(line 380 of the redesigned file). This PR restores the path, adapted to the current redesigned file.

## Acceptance (from issue #9)
> On staging timeline-peek opened WITHOUT the extension, a **"Sign in with OAuth3"** wallet flow
> appears instead of a dead-end. Flow (Tier 2): open → Sign in → approve twitter read → the timeline
> renders real tweets. Screenshot each step. No reliance on `window.oauth3`.

## Functional verification — DONE, live on the DEPLOYED staging URL
1. **Deployed** this branch to staging: `bash scripts/deploy-static.sh timeline-peek --ref HEAD`
   → `tree=106757e29817`. Confirmed the deployed `https://…dstack…/timeline-peek/` now serves the
   redesigned page with the **"Sign in with OAuth3"** button + `connectViaWallet` present, and the
   dead-end string is gone (`grep -c` = 0). Title is now `Home / Timeline Peek` (the redesign #48,
   which had itself never been deployed, rode along).
2. **Drove the deployed page through the envoy bridge** (real Brave). Simulated the no-extension
   condition the fix targets — `Object.defineProperty(window,'oauth3',{value:undefined,…})` —
   cleared `localStorage`, and clicked Connect. Transcript (within one flock'd window):
   - click fired with `typeof window.oauth3 === "undefined"` → the **wallet branch** ran
     (`viaExt=false`, note `"Self-provisioning a wallet in this browser…"`) — **not the dead-end**.
   - ~2s later: `localStorage.oauth3_didkey === true` (Ed25519 wallet self-provisioned),
     `localStorage.oauth3_session === true` (signed into the node).
   - `note === "no jar synced for twitter"` — `connectViaWallet()` completed
     login → /api/connect → /approve → poll → `loadFeed`, and the feed read returned its **real**
     status for a freshly self-provisioned subject.
   - Reproduced across multiple attempts; the flow completes in ~2s.
3. **HTTP-level cross-check** (node + WebCrypto, no browser): did:key self-provision →
   `POST /api/login {did,challenge,signature}` → `200 {subject, session}` → `POST /api/connect` →
   `POST /api/connect/:id/approve` (Bearer) → poll → **`tok-twitter-…`** → `GET /api/twitter/feed`
   → `409 {"error":"no jar synced for twitter"}`. This is exactly the path the restored code drives,
   and it still works against the current staging node (the server changed since #10 — re-verified).
4. **Parse:** extracted the inline `<script>` and ran `node --check` → `PARSE_OK`. Diff is +86/−4,
   one file; the extension-first path is byte-identical when the extension IS present.

## What I could NOT verify — TRUE external blocker (rendered screenshots)
The bridge `screenshot` tool **times out on every attempt (20/20)** while an unrelated job —
`oram-research/build_dataset.py` (PID 3591615, ~80+ min, lock `/home/amiller/.dataset.lock`) —
continuously drives the **single shared envoy browser** to `eprint.iacr.org` papers. The envoy
extension is saturated; no screenshot window opens. Other avenues exhausted:
- **Container framebuffer capture:** the `envoy-browser` container has **no** `scrot`/`import`/`xwd`/
  `ffmpeg`/PIL/Xlib, and I will not `apt install` into the operator's browser container.
- **neko screenshot API:** `/api/screenshot` → `404` (endpoint absent in this neko build).
- **Killing the dataset build:** no — it is the operator's active research job.

Per the spec, a PR whose visual verification could not be driven is labeled **`needs-e2e`**
(**NOT** `ready-to-merge`). The functional proof above is real and end-to-end, but I do **not**
claim a rendered screenshot I did not capture.

## Remaining acceptance clause (separate blocker)
"the timeline renders real tweets" needs a **twitter-jar-synced subject**. No subject reachable
from this box holds the jar — the documented `u-swarm` subject `u-cc7f19ff…` and the
`swarm-userkey` subject `u-eaf13541…` both return `409 {"error":"no jar synced for twitter"}`.
Seeding the twitter jar is an operator/ingest step (the prod jar is operator-run per
`box-inventory.md`).

## To finish Tier 2 (operator, or next iteration once the envoy browser is free)
1. With `build_dataset.py` not running (or a second/clean browser profile), open the deployed
   staging `/timeline-peek/` with the oauth3 extension **disabled for the page**.
2. Screenshot the **"Sign in with OAuth3"** landing (proves no dead-end).
3. Click → screenshot the wallet self-provision → token mint → feed read.
4. (For *real tweets*) seed the twitter jar for the signed-in subject, then screenshot the feed.
