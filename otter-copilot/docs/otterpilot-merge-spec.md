# otterpilot merge spec — one meeting-copilot app

Merge the rescued Otter Copilot (this directory, python) and the existing `../otterpilot`
(deno) into ONE app named **otterpilot**, living at `otterpilot/` in this monorepo, deployed
on pod.dstack via the git path so its landing card shows real source provenance.

The product is a suite for following along with a meeting better — and for being ready when
you're called on to present. It pairs with the interleave brainrot box: both watch the room's
live speech; interleave plays, otterpilot keeps you oriented.

## What each side contributes

From **this directory** (the feature side — all of it survives):
- live transcript tail + recap button + slide panel (`otter_web/server.py`, `index.html`)
- conversation-graph decoder: segments → typed nodes (`topic|question|point|decision|
  divergence|action_item|aside`) → clusters; topic graph, per-cluster recap, decisions rail
  (`docs/decoder-graph-spec.md`)
- replay harness (`otter_web/replay.py`) — drives the full live-decode path from a captured
  transcript, offline and deterministic by default
- sync toolkit (`otter_sync.py` archive pull, frames, audio), insights, connections map
- NEAR private inference for recap/decode; Gemini vision for slides

From **`../otterpilot`** (the architecture side):
- the credential path: the oauth3 node holds the sealed Otter cookie; the app holds only a
  SCOPED, REVOCABLE token (`OAUTH3_TOKEN`) and calls `node /api/otter/live` + `/api/otter/frame`.
  The browser talks only to the app. `browser_cookie3` / raw-cookie reads do not ship in the
  pod build — they remain a laptop-dev mode, selected explicitly, never a fallback.
- deno/tee-daemon packaging conventions (manifest with `public: true`, `listen`, env passthrough)

Language call: keep the python engine (the decoder/graph state machine is the value; porting it
is risk with no user-visible gain) and deploy as an image or dockerfile runtime on the daemon,
OR port `server.py` to deno if the swarm proves the decoder ports cleanly under the replay
harness first. Either way the credential path above is non-negotiable.

## Deliverables

1. `otterpilot/` merged app: feature side + token credential path, one server, one UI.
2. Landing page at `/` of the app, interleave-landing quality: says what it is, the two-mode
   story (follow along / be ready to present), a live screenshot or short capture, and an
   HONESTY section (what's e2ee and what isn't — today Gemini vision and the otter cookie
   fetch are TLS-only, recap/decode via NEAR is confidential inference).
3. Deployed to pod.dstack via git path (source + commit recorded → verify card works, cf.
   dstack-webhost #88), `public: true`, listed on the pod landing.
4. `../otterpilot` (old deno app) deleted in the same PR that ships the merge.

## How the swarm tests it (the measure)

Acceptance must verify, not ping (RFC 0030). The replay harness is the test backbone — no live
meeting, no real cookie, no NEAR key needed for the core gate.

Gate 1 — deterministic replay (CI, offline, must pass on every PR):
- a PUBLIC fixture transcript committed at `fixtures/` (synthetic or from a published talk —
  NEVER internal meeting data; `eval/` gold stays in the private tree)
- `replay.py fixtures/<t>.txt --max N --batch B` with the stub decoder asserts:
  - every segment lands in exactly one node; node types are from the closed set
  - the fixture's planted decisions/action items appear in `GET /graph` `.decisions`
  - per-cluster recap endpoint returns text that references only that cluster's segments
  - re-running produces byte-identical graph JSON (determinism)

Gate 2 — credential-path proof (staging, needs staging oauth3 node):
- app deployed with a scoped token minted on the staging node; assert `/live` serves segments
  while the app env contains NO otter cookie (grep the container env), and that revoking the
  token flips `/live` to an error surfaced verbatim in the UI (no silent retry, no fallback)

Gate 3 — evidence report (per merge PR, human-graded):
- screenshots of: live feed mid-replay, topic graph with ≥2 clusters, decisions rail populated,
  slide panel, landing page — each screenshot must SHOW the caption's claim (a lobby or empty
  panel proves serving, not working)
- the report states which gates ran and links the replay logs

Score = gates passed. A PR that touches decode/graph logic and doesn't extend the fixture set
with the case it claims to fix does not merge.

## Non-goals (first slice)

- matrix sidecar stays optional (env-gated), not part of the merge gate
- calendar/google connections panel ports as-is or waits; it is not on the critical path
- no new inference providers; NEAR text + Gemini vision as today, with honesty labels
