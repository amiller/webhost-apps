# Evidence — issue #90 (goodpoint-box idle shutoff)

Tier **1** (backend runtime behavior; observable via `/diag` + `/events`). Demonstrated over **real
HTTP against a locally-run instance** of `goodpoint-box/server.ts` (Deno.serve). Deployed staging
was not driven: the box does not hold the operator's `NEAR_API_KEY`/`CHUTES_API_KEY`, so the weave
cannot run there, and the app exposes no `/_api/version` route — both stated plainly here. A live
Tier-2 visual walk (canvas actually idling mid-meeting) additionally needs a live Otter meeting and
is out of reach from this box; named under "could NOT verify" in the PR.

The idle **logic** — the thing this issue actually changes — is exercised end-to-end below.

## How to reproduce

```
export PORT=<free> OAUTH3_CORE="http://127.0.0.1:9" OTTER_TOKEN=fake \
  NEAR_API_KEY=fake CHUTES_API_KEY=fake TOOLSMITH_MODEL=m COMPOSITOR_MODEL=m \
  WEAVE_IDLE_MS=1000 OTTER_IDLE_MS=600000
deno run --allow-net --allow-env goodpoint-box/server.ts &
```
(OAUTH3_CORE is a dead local port so the otter poll fails instantly without contacting any real host.
The supervisor ticks every 5s, so with `WEAVE_IDLE_MS=1000` the first tick after `/start` trips the idle.)

## 1. POST /start → master on, both lanes running

```
$ curl -sS -X POST $B/start
{"ok":true,"running":true}
```

## 2. GET /diag — just started, weave + otter both running

```json
{
  "enabled": true,
  "weave_running": true,
  "otter_running": true,
  "weave_idle_ms": 1000,
  "otter_idle_ms": 600000,
  "last_consumer_at": 1784235451896,
  "last_live_at": 1784235451896,
  "last_weave_idle_at": 0,
  "last_otter_idle_at": 0,
  "weave_idle_reason": "",
  "otter_idle_reason": ""
}
```

## 3. sleep 6s with NO /events polls  (nobody is watching)

## 4. GET /diag — weave IDLED, otter STILL RUNNING  ✅ acceptance

```json
{
  "enabled": true,
  "weave_running": false,
  "otter_running": true,
  "weave_idle_ms": 1000,
  "otter_idle_ms": 600000,
  "last_consumer_at": 1784235451896,
  "last_live_at": 1784235451896,
  "last_weave_idle_at": 1784235456910,
  "last_otter_idle_at": 0,
  "weave_idle_reason": "no /events poller for 5s",
  "otter_idle_reason": ""
}
```

## 5. GET /events?since=0 — a viewer polls (heartbeat refreshed; weave resumed)

```
{"seq":5,"events":[
  {"type":"activity","who":"toolsmith","state":"thinking"},
  {"type":"status","text":"Fetch failed: Requests to port 9 are blocked"},
  {"type":"status","text":"Fetch failed: Requests to port 9 are blocked"},
  {"type":"idle","lane":"weave","reason":"no /events poller for 5s"},
  {"type":"activity","who":"toolsmith","state":"thinking"}
],"running":true,"weave_running":true,"otter_running":true}
```

The stream carries the `{type:"idle",lane:"weave",reason:"no /events poller for 5s"}` event, and the
two `status` events are the unprovisioned-env otter errors surfacing honestly (no crash, no masking).

## 6. GET /diag — weave RESUMED on the viewer poll  ✅ acceptance

```json
{
  "enabled": true,
  "weave_running": true,
  "otter_running": true,
  "weave_idle_ms": 1000,
  "otter_idle_ms": 600000,
  "last_consumer_at": 1784235458002,
  "last_live_at": 1784235451896,
  "last_weave_idle_at": 1784235456910,
  "last_otter_idle_at": 0,
  "weave_idle_reason": "",
  "otter_idle_reason": ""
}
```

`last_consumer_at` advanced (1784235458002 vs the start's 1784235451896), `weave_idle_reason` cleared,
`weave_running` back to true.

## Offline unit tests (the issue's "offline test" acceptance)

```
$ deno test --allow-env
running 7 tests from ./tests/server_test.ts
otter cursor and dedup logic keeps only new orders ... ok
judge JSON parse and threshold marks only score>=7 bangers ... ok
/goodpoints returns the server-side ledger ... ok
#90 idle: a stale viewer window stops the weave; a new /events poll resumes it ... ok
#90 idle: a quiet meeting idles the otter lane too; /start resumes everything ... ok
#90 /events refreshes the consumer heartbeat and exposes lane state ... ok
#90 /diag reports the idle block ... ok
ok | 7 passed | 0 failed
```

`deno check goodpoint-box/server.ts` → exit 0 (clean).
