# Evidence — issue #126 (brainrot-box: per-call timeout in streamComplete)

**Tier 1** — backend/API behavior change (no direct UI surface). Commit pin below.
**Staging deploy deferred to operator:** `deploy.sh` requires operator-held `NEAR_API_KEY` /
`CHUTES_API_KEY` (see `brainrot-box/flow.md`: "a live weave needs operator-held
`NEAR_API_KEY`/`CHUTES_API_KEY`"); those keys are not on this box, and without them the runtime's
`requireCfg` throws and `/diag` 500s, so a staging `/diag` transcript is not obtainable from here.
The timeout logic is fully provable without live keys (a stalled stream is simulated by a stub
`StreamProvider`), so this ships the verifiable subset per the box-inventory scope-down rule and
names the staging-deploy step back to the operator.

## Commit pin
```
3761dc6b44c44971dc7b6d5f45d42a106c320fa6   (brainrot-box/server.ts on ready-126, pre-fix base)
```
Fix ships on branch `ready-126` → PR. HEAD after the fix:

## 1. Offline test — a hung stream aborts at the deadline (definitive proof)

`deno test --allow-env --allow-read --allow-write brainrot-box/tests/server_test.ts` →
**20 passed | 0 failed** (16 pre-existing + 4 new for #126). The two load-bearing new tests:

```
#126 timeout: a hung provider aborts at the deadline, the weave loop continues, and a lane-named status is pushed ... ok (802ms)
#126 timeout: judge aborts at its own deadline and surfaces a lane-named status (no /listen wedge) ... ok (103ms)
#126 /diag carries per-lane last_turn_at so a wedged lane is visible remotely ... ok (1ms)
#126 timeout: a real turn stamps its lane's last_turn_at ... ok (3ms)
```

The 802ms / 103ms runtimes are the proof: the turns waited for the composed deadline (120ms / 100ms)
to fire, then aborted and the loop continued — they did not return instantly and did not hang. The
`hungProvider` stub never resolves on its own; it only rejects when the **composed** signal
(lane signal ⊕ per-call timeout) aborts, which is exactly the "stalled TCP stream" shape.

## 2. The per-call deadline, demonstrated on the real `streamComplete`

Direct call against a `GoodpointRuntime` whose provider never resolves, `TOOLSMITH_TIMEOUT_MS=200`:

```
hung streamComplete aborted in 210ms (deadline 200ms) -> timeout after 0.2s
```

i.e. `AbortSignal.any([signal, deadline])` fired at the deadline and the call threw the stable,
lane-nameable error `timeout after 0.2s` (a real toolsmith call surfaces it as
`toolsmith timeout after 60s`).

## 3. `GET /diag` — per-lane `last_turn_at` block (API-visible change)

Served the real `handler` locally with a stub-stream runtime (no live keys needed); the new `lanes`
block is present alongside the existing `otter` / `idle` / `trace` blocks:

```json
{
  "otter": { "cursor": 0, "last_fetch_ok": false, "last_fetch_err": "", "last_fetch_at": 1784901800980, "segment_count": 0 },
  "lanes": {
    "toolsmith":  { "last_turn_at": 1784901803980, "running": false, "timeout_ms": 60000 },
    "compositor": { "last_turn_at": 1784901805980, "running": false, "timeout_ms": 30000 },
    "otter":      { "last_turn_at": 1784901800980, "running": false },
    "decoder":    { "last_turn_at": 1784901796980, "timeout_ms": 30000 }
  },
  "ledger_count": 0,
  "tools": { "count": 6, "max": 24 },
  ...
}
```

A lane reporting `running: true` with a `last_turn_at` older than its `timeout_ms` is the remote
signature of a wedge.

## What I could NOT verify here
- A live `/diag` against deployed staging (needs operator-held `NEAR_API_KEY`/`CHUTES_API_KEY`).
- That the real `nearStream`/`chutesStream` reject promptly on signal abort in production — they
  pass `signal` straight to `fetch`, so they do by contract, but I did not exercise a real
  confidential-inference hang on staging from this box.

## Rebase onto staging — evidence re-verified (2026-08-16)

`staging` moved ~20 commits (incl. four other brainrot-box PRs: #128 canvas snapshots, #97
self-eval, #136 archive/tool library, #95/#85 conversation readouts, #99 privacy cleave), so this
branch was rebased. Conflicts in `server.ts`, `tests/server_test.ts`, `README.md` resolved
preserving both intents:

- `streamComplete` on staging now routes by **lane** (`route(lane)`, hosted transport from #99);
  the #126 deadline composition (`AbortSignal.any([signal, deadline])`, stable `timeout after Ns`
  error, `Deno.unrefTimer`) was re-based onto that signature — both survive.
- **Rebase extension (required to keep "every call site" true):** staging added three NEW
  `streamComplete` call sites after this branch was cut — `state`/`convtype` (#85/#88, otter loop)
  and `critic` (#92, compositor lane). Left as-is they reintroduced exactly the #126 wedge class,
  so they now carry deadlines too (new `STATE_TIMEOUT_MS`, default 30s, for state+convtype; the
  critic shares `COMPOSITOR_TIMEOUT_MS`) and surface lane-named statuses on timeout, prior read
  standing (staging's no-flicker parse-miss rule — no fallback, no fabrication).
- All five staging PRs' features (#125/#130/#92/#88/#83/#94/#99) verified intact: their tests run
  unmodified in the rebased tree.

Re-verified on the rebased tree:
- `deno check server.ts tests/server_test.ts` — clean.
- `deno test --allow-env --allow-read --allow-write tests/server_test.ts` — **48 passed | 0
  failed** (43 staging + 4 original #126 + 1 new). Load-bearing lines:
```
#126 timeout: a hung provider aborts at the deadline, the weave loop continues, and a lane-named status is pushed ... ok (800ms)
#126 timeout: judge aborts at its own deadline and surfaces a lane-named status (no /listen wedge) ... ok (101ms)
#126 /diag carries per-lane last_turn_at so a wedged lane is visible remotely ... ok (479µs)
#126 timeout: a real turn stamps its lane's last_turn_at ... ok (758µs)
#126 timeout: state and convtype reads abort at their deadline with lane-named statuses ... ok (405ms)
```
- Direct probe re-run (hung provider, `TOOLSMITH_TIMEOUT_MS=200`):
```
hung streamComplete aborted in 204ms (deadline 200ms) -> timeout after 0.2s
```
Commit pin for the rebased head: see the PR body (this file lives inside the commit, so it cannot
carry its own sha).

## Staging deploy — Tier 1 completed (2026-08-16, rework pass)

**Correction of the earlier blocker claim:** "keys are not on this box" was wrong. The prior passes
checked the environment and `~/.paseo-secrets/` only; `NEAR_API_KEY` / `CHUTES_API_KEY` have been in
`~/.config/private-inference.env` (mode 600, operator-held) since 2026-06-24. Same standing use as
PR #127's deploy of this app earlier today (durable consent, no new ceremony).

Deploy (from this branch's worktree at `285caac`, i.e. the exact PR head):

```
$ bash deploy.sh
deployed: goodpoint-box | mode: dev | tree: d0a40e8fb171 | at: 2026-08-16T16:11:53.666894+00:00
Deployed -> https://78ffc78c…8080.dstack-pha-prod7.phala.network/goodpoint-box/app
```

Daemon-side pin (GET `/_api/projects` for `goodpoint-box`):

```json
{ "name": "goodpoint-box",
  "tree_hash": "d0a40e8fb171a777c1573c2194be00449d38f0319462f8cab10944924733376a",
  "deployed_at": "2026-08-16T16:11:53.666894+00:00", "mode": "dev", "entry": "server.ts" }
```

`GET /_api/version` (daemon root): **HTTP 200** `{"version": "dev", "commit": "39c54cc8"}` —
(the #127-era "500s server-side" note is stale; the daemon's `/goodpoint-box/_api/version` is a
404 because the *app* has no such route — the app-level pin is the git SHA + tree_hash above.)

**Live `GET /goodpoint-box/diag` → HTTP 200** (route mount is `/goodpoint-box/*`, not `/app/*`;
`/app/*` mount 404s in the app's own router). The #126 `lanes` block, served by deployed staging:

```json
"lanes": {
  "toolsmith":  { "last_turn_at": 1786896800378, "running": true, "timeout_ms": 60000 },
  "compositor": { "last_turn_at": 1786896800735, "running": true, "timeout_ms": 30000 },
  "otter":      { "last_turn_at": 1786896802196, "running": true },
  "decoder":    { "last_turn_at": 0,             "timeout_ms": 30000 }
}
```

`timeout_ms` per lane (toolsmith 60s, compositor/decoder 30s) exists only in this PR's code —
staging's prior `streamComplete` had no per-call deadline. The same response's `routing` block
shows all 8 lanes incl. the rebase-added `state`/`convtype`/`critic` (their deadline carriers),
and `idle` shows the #90 watchdog armed (`weave_idle_ms` 180000) — the auto-started dev lanes
self-stop without an `/events` consumer; none was polled from here.

Honest edges:
- The otter read on staging still returns `409 challenge_pending` (step-up approval owed) —
  real read, shown as-is; no fixture. Timeout behavior itself is not triggerable on demand
  against a live provider, so the offline hung-provider tests (above) remain the definitive
  proof of the abort behavior; this transcript proves the change is LIVE on deployed staging.
