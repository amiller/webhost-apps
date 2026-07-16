# goodpoint-box Flow Notes

This file mirrors the issue #80 evidence summary for the app directory.

- Local UI render evidence: `../.evidence/issue-80/01-local-ui.png`.
- Real Otter ingestion attempt: `../.evidence/issue-80/otter-ingest.json`.
- Deployment attempt: `../.evidence/issue-80/deploy-attempt.txt`.

Current status: blocked for complete Tier 2 verification. The OAuth3 Otter read returned
`challenge_pending`, and staging deployment needs operator-held `NEAR_API_KEY` and `CHUTES_API_KEY`.

## #87 — popout no longer blanks the app (Picture-in-Picture)

Popout step sequence (verified functionally via the envoy bridge 2026-07-16; full transcript in
`../.evidence/issue-87/bridge-transcript.txt`):

1. **popout** — clicking `popout` no longer toggles `body.pop`; the header, live-transcript pane,
   good-points pane and bottom strip all stay visible. The canvas alone is moved into a Document
   Picture-in-Picture window (or mirrored to a video PiP on browsers without `documentPictureInPicture`).
   - OLD/staging repro: `popout()` set `body.pop` → `.top/.left/.strip { display:none }` (page blanked).
   - NEW/ready-87: same `popout()` call leaves `body.pop` unset, panes `display:flex/grid` (bug gone).
2. **main page still shows panes** — transcript ("Waiting for live Otter segments.") + good points
   ("No bangers yet.") + dots remain rendered while popped out.
3. **close popout → still live** — `pagehide` / `leavepictureinpicture` restores the canvas and resumes
   the animation loop; the poll/SSE loop is never touched, so no refresh is needed.

Fix is client-only (`index.html`); `deno check server.ts` and `node --check` on the script both clean.
PNG screenshots not captured (envoy `screenshot` tool timed out — shared envoy browser saturated by
the operator's `oram-research` job); PR labeled `needs-e2e` until the visual step can be driven.
