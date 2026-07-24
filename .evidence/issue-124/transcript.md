# Evidence — issue #124 (brainrot-box: persist session traces)

**Tier 1** — backend/API behavior (new `/traces`, `/traces/<id>` routes + `/diag.trace`; no UI).
Demonstrated end-to-end over **real HTTP against deployed staging** (`goodpoint-box` on the
hermes-staging tee-daemon). The staged code is commit `6af1c34` on branch `ready-124`.

## Story / Acceptance (from #124)
- Every event appended to the current session's JSONL at push time; file rotates on /reset and on boot.
- `GET /traces` → `[{id, started, bytes, events}]` for all trace files on disk.
- `GET /traces/<id>` streams the JSONL back (content-type `application/x-ndjson`).
- `/diag` gains `trace: {session_id, events_written, write_ok}`.
- Offline test: runtime with stub streams writes events to a temp dir, `/traces` lists it, `/traces/<id>` round-trips.
- Evidence: one committed trace from a real staging run.

## Discovery (the issue's first gate): is the dev-mode cwd writable?
`POST`-free first request constructs the runtime and opens the boot-session trace file:

```
$ curl -sS $APP/diag | jq .trace
{
  "session_id": "2026-07-24T13-00-34-207Z-8c4b8d8a",
  "events_written": 6,          # 6 starter tools seeded at boot, each appended
  "write_ok": true              # ← the dev-mode app cwd IS writable
}
```
→ **writes are possible**; persistence proceeds (no in-memory fake). An unwritable cwd instead
surfaces `write_ok=false` + a `status` event — covered by the offline "unwritable cwd" test.

## 1. GET /traces — list every session trace on disk

```
$ curl -sS $APP/traces
[
  {
    "id": "2026-07-24T13-00-34-207Z-8c4b8d8a",
    "started": "2026-07-24T13:00:34.207Z",   # real ISO reconstructed from the fs-safe id
    "bytes": 20842,
    "events": 106
  }
]
```

## 2. GET /traces/<id> — stream the JSONL back (NDJSON)

```
$ curl -sS -D - -o trace.jsonl $APP/traces/2026-07-24T13-00-34-207Z-8c4b8d8a
HTTP/1.1 200 OK
Content-Type: application/x-ndjson
Content-Length: 20842
```
Body: 106 lines, every line `{"seq":N,"ev":{...}}`, `seq` monotonic 1..106, 0 unparseable. Event
type histogram over the real run: `{tool: 6, activity: 44, status: 45, composition: 11}` (the 45
`status` are the otter lane's 401s — no live meeting token — exactly the kind of event that used
to age out of the 500-window and is now on disk). The full file is committed at
`.evidence/issue-124/trace-staging.jsonl` (this is the "one committed trace from a real staging
run" acceptance item). First line:

```
{"seq":1,"ev":{"type":"tool","tool":{"name":"starfield_drift", ...},"updated":false}}
```

## 3. /diag trace block (after running the lanes)

```
$ curl -sS $APP/diag | jq .trace
{ "session_id": "2026-07-24T13-00-34-207Z-8c4b8d8a", "events_written": 105, "write_ok": true }
```

## Commit pin (the /_api/version caveat)
The Constitution's Tier-1 pin is `GET /_api/version == your commit`. On this daemon that endpoint
is **broken server-side** — it returns `HTTP 500 "Server got itself in trouble"` both authed and
unauthed (alt paths `/api/version`, `/_api/info` → 404). That is a pre-existing daemon defect,
not something this app PR can fix, and it is outside this issue's scope. Pinning the deployed
code to this PR instead by:
- **git:** branch `ready-124`, commit `6af1c34`.
- **daemon record:** `GET /_api/projects` → `goodpoint-box` `tree_hash=91a5c60ef1b9…`,
  `deployed_at=2026-07-24T13:00:21` (matches `deploy.sh` output).
- **behavior pin:** the `/traces` route, `/traces/<id>` NDJSON stream, and `/diag.trace` block
  exist **only** in commit `6af1c34` — their presence on the live URL proves the running code is
  this PR's code.

## Offline tests (temp-dir, no network)
`deno test --allow-all tests/server_test.ts` → **16 passed / 0 failed** (13 prior + 3 new). New:
push→append + `/traces` list + `/traces/<id>` round-trip; `/reset` rotation; and the unwritable-cwd
no-fallback case (`status` event + `write_ok=false`). `deno check server.ts` clean.

## Redepploy durability (honest caveat, also in README)
Traces survive a process restart within the same deployed tree and accumulate across `/reset`. A
**redeploy** wipes them: redeploying produced a fresh boot session
(`2026-07-24T13-04-25-206Z-1d225358`, `write_ok=true`) and the prior trace was gone — the daemon
re-extracts the tarball, which does not carry `traces/`. This is inherent to the deploy model; the
500-event in-memory window (the gap #124 closes) is no longer the only record between resets.

## What I could NOT verify
- `/_api/version` commit pin — daemon endpoint returns 500 (daemon-side defect, noted above).
- A speech-seeded trace (the issue's "espeak seeding is fine" option): no `espeak`/`ffmpeg`/`sox`
  on this box, so no `/listen` ingest. The committed staging trace instead spans
  tool/activity/status/composition events produced by the live weave+otter lanes — a real run.
