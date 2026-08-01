# Flow — issue #125: brainrot-box canvas snapshot capture + gallery

Asserts the issue's `## Acceptance`, one bullet at a time. Change is **Tier 2** (user-visible
`/app` canvas capture) **+ Tier 1** (new `/snapshot`, `/snapshots`, `/snapshots/<s>/<f>` API).

## 1. POST /snapshot stores the jpeg with session + timestamp; rejects non-image / >2MB with 400

Local-serve HTTP transcript (`http://127.0.0.1:8931`, branch served via `deno run`):

```
POST /snapshot (image/jpeg, 19 B) → 201
  {"session":"2026-07-24T13-23-52-416Z-416799a1","file":"2026-07-24T13-24-12-317Z-0001.jpg","t":1784899452317,"bytes":19}
POST /snapshot (text/plain)           → 400 {"error":"expected image/jpeg"}
POST /snapshot (image/jpeg, bad magic)→ 400 {"error":"not a jpeg"}
POST /snapshot (>2MB)                 → 400 {"error":"body exceeds 2MB"}
```

`/diag.snapshot` after a store: `{dir, session_id, write_ok:true, written:N, last_err:""}`.

## 2. GET /snapshots → [{session,file,t,bytes}]; GET /snapshots/<session>/<file> serves the image

```
GET /snapshots → [{ "session":…, "file":…, "t":…, "bytes":19 }]   (bare array, as specified)
GET /snapshots/<session>/<file> → 200, Content-Type: image/jpeg, bytes round-trip intact (ffd8…ffd9)
```

## 3. /app captures on goodpoint + 60s interval (only while weave_running); errors become status events

`public/index.html` adds `captureSnapshot(reason)`:
- on every `goodpoint` event → `captureSnapshot("goodpoint")`;
- each `/events` poll, `if (weaveRunning && Date.now()-lastIntervalSnap >= 60000)` → `captureSnapshot("interval")`;
- any capture/POST failure → `setRunState("snapshot … failed: …")` (client) AND a server-side store
  failure is pushed as a `status` event to every viewer (no silent swallow, no mock).

Driven through the **real browser** (envoy bridge) against the served branch: calling the page's own
`captureSnapshot('verify')` produced a new 51,016-byte canvas jpeg in `/snapshots` within 2s
(2 → 3 snapshots). The captured image is a valid baseline JPEG **1090×839, 3 components** (`file`
output) — i.e. a genuine image of what the box painted, not a fixture.

## 4. Offline test: handler round-trips a synthetic jpeg through POST /snapshot → GET

`brainrot-box/tests/server_test.ts` — 6 new tests (18 total, all green):
- session id is filesystem-safe and matches #124's trace id format;
- POST /snapshot round-trips through `/snapshots` and `/snapshots/<s>/<f>`; rejects non-image / >2MB with 400;
- per-session 200-file cap evicts oldest → announces a `status` event;
- `/reset` rotates the session id; `/diag` reports the snapshot block;
- path traversal in `/snapshots/<s>/<f>` is rejected (404).

## 5. Evidence: at least one real snapshot from a staging run committed under .evidence/

Deployed the branch to the **hermes-staging** daemon (`brainrot-box`, mode dev, tree `2de02e6fc661`;
see `deploy-staging.json`). Navigated the real browser to the **staging** `/app` (HTTPS staging URL
confirmed via `location.href`), captured the live canvas (`toDataURL('image/jpeg',0.8)` → 50,450 B,
magic `ffd8`), POSTed it through the **staging** `/snapshot` (201), and retrieved it byte-identical
via staging `/snapshots/<s>/<f>`.

- `snapshot-staging-canvas.jpg` — the real 50,450-byte jpeg the staging box painted (the artifact the issue asks for).
- `snapshot-real-canvas.jpg` — same path captured from a local serve of the branch (50,434 B).
- `02-app-staging.png` — the staging `/app` UI (canvas rendering).
- `01-app-ui.png` — the served branch's `/app` UI.
- `diag-staging.json`, `transcript-staging.txt`, `deploy-staging.json` — supporting Tier-1 artifacts.

## Honest notes / what was NOT exercised

- The staging run used **dummy NEAR/CHUTES inference keys** (those creds are not on this box).
  The snapshot feature never calls inference, so the routes work unchanged; the AI lanes fail →
  `status` events (401/errored), exactly the isolated-run behavior. A banger-driven capture was not
  produced on staging (needs a live meeting + real inference); the goodpoint capture path is the
  same `captureSnapshot` call proven via the `verify` trigger.
- `NEAR_API_KEY` / `CHUTES_API_KEY` are absent from this box, so a full-pipeline staging run is
  operator-run; the verifiable subset (the entire snapshot feature) is shipped here.
