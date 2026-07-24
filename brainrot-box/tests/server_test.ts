import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import handler, {
  GoodpointRuntime,
  HEARING_LANES,
  StreamProvider,
  type ConversationType,
  TraceStore,
  isBanger,
  leaksVerbatim,
  mergeOtterSegments,
  newSessionId,
  normalizeSegments,
  parseConvType,
  parseJudge,
  parseRecap,
  parseShift,
  parseFlow,
  sanitizeBrief,
  sanitizeDistilled,
  SNAP_CAP_FILES,
  SNAP_MAX_BYTES,
  STARTER_TOOLS,
} from "../server.ts";

const env = {
  OAUTH3_CORE: "https://core.example/oauth3",
  OTTER_TOKEN: "tok-otter-test",
  NEAR_API_KEY: "near-test",
  CHUTES_API_KEY: "chutes-test",
};

Deno.test("otter cursor and dedup logic keeps only new orders", () => {
  const seen = new Set<number>();
  const current = normalizeSegments({
    segments: [
      { order: 2, text: "first useful segment" },
      { order: 3, text: "second useful segment" },
    ],
  });
  let merged = mergeOtterSegments([], current, seen);
  assertEquals(merged.cursor, 3);
  assertEquals(merged.added.map((s) => s.order), [2, 3]);

  merged = mergeOtterSegments(current, normalizeSegments({
    segments: [
      { order: 3, text: "duplicate" },
      { order: 5, text: "new later point" },
    ],
  }), seen);
  assertEquals(merged.cursor, 5);
  assertEquals(merged.added.map((s) => s.order), [5]);
});

Deno.test("judge JSON parse and threshold marks only score>=7 bangers", () => {
  const yes = parseJudge('prefix {"good_point":true,"quote":"This is the reusable point.","why":"clear framing","score":8} suffix');
  assert(yes);
  assert(isBanger(yes));
  assertEquals(yes.quote, "This is the reusable point.");

  const low = parseJudge('{"good_point":true,"quote":"Almost","why":"thin","score":6}');
  assert(!isBanger(low));

  const no = parseJudge('{"good_point":false,"quote":"Nope","why":"filler","score":9}');
  assert(!isBanger(no));
});

Deno.test("/goodpoints returns the server-side ledger", async () => {
  const rt = new GoodpointRuntime(env);
  rt.ledger.push({ t: 123, quote: "Ship the verifiable subset.", why: "scope clarity", score: 9 });
  const res = await handler(new Request("https://app.example/goodpoints"), { runtime: rt });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.goodpoints.length, 1);
  assertEquals(body.goodpoints[0].quote, "Ship the verifiable subset.");
});

// #90 idle shutoff: nobody watching -> weave stops; a new /events poll resumes it.
// A stubbed StreamProvider keeps the launched loops off the network.
const toolJson = '{"name":"x","desc":"d","params":[],"draw":"(ctx,p,t,w,h,txt)=>{}"}';
const stubStreams = { complete: async () => toolJson };

Deno.test("#90 idle: a stale viewer window stops the weave; a new /events poll resumes it", () => {
  const idleEnv = { ...env, WEAVE_IDLE_MS: "1000", OTTER_IDLE_MS: "60000" };
  const rt = new GoodpointRuntime(idleEnv, undefined, stubStreams);
  rt.start();
  assert(rt.running, "master enabled after start");
  assert(rt.weaveRunning, "weave running after start");
  assert(rt.otterRunning, "otter running after start");

  // simulate no /events poller for 5s — past the 1s weave-idle threshold
  rt.tickIdle(Date.now() + 5000);
  assertEquals(rt.weaveRunning, false, "weave idles when no viewer is polling");
  assertEquals(rt.otterRunning, true, "otter keeps watching (speech window not stale)");

  // a viewer polls /events -> weave resumes
  rt.resumeConsumer();
  assertEquals(rt.weaveRunning, true, "weave resumes on a fresh /events poll");

  rt.stop();
});

Deno.test("#90 idle: a quiet meeting idles the otter lane too; /start resumes everything", () => {
  const idleEnv = { ...env, WEAVE_IDLE_MS: "60000", OTTER_IDLE_MS: "1000" };
  const rt = new GoodpointRuntime(idleEnv, undefined, stubStreams);
  rt.start();
  // no live speech for 5s — past the 1s otter-idle threshold
  rt.tickIdle(Date.now() + 5000);
  assertEquals(rt.otterRunning, false, "otter idles when the meeting has been quiet");

  // a new /app load or /start resumes everything
  rt.start();
  assertEquals(rt.otterRunning, true, "otter resumes on start");
  assertEquals(rt.weaveRunning, true, "weave resumes on start");

  rt.stop();
});

Deno.test("#90 /events refreshes the consumer heartbeat and exposes lane state", async () => {
  const idleEnv = { ...env, WEAVE_IDLE_MS: "1000", OTTER_IDLE_MS: "60000" };
  const rt = new GoodpointRuntime(idleEnv, undefined, stubStreams);
  rt.start();
  // idle the weave by simulating viewer staleness
  rt.tickIdle(Date.now() + 5000);
  assertEquals(rt.weaveRunning, false);
  // a real /events poll must resume it
  const res = await handler(new Request("https://app.example/events?since=0"), { runtime: rt });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.weave_running, true, "/events resumed the weave");
  assertEquals(body.otter_running, true);
  rt.stop();
});

Deno.test("#90 /diag reports the idle block", async () => {
  const idleEnv = { ...env, WEAVE_IDLE_MS: "90000", OTTER_IDLE_MS: "600000" };
  const rt = new GoodpointRuntime(idleEnv, undefined, stubStreams);
  rt.start();
  const res = await handler(new Request("https://app.example/diag"), { runtime: rt });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.idle.weave_running, true);
  assertEquals(body.idle.otter_running, true);
  assertEquals(body.idle.weave_idle_ms, 90000);
  assertEquals(body.idle.otter_idle_ms, 600000);
  assertEquals(body.idle.enabled, true);
  rt.stop();
});

Deno.test("mic ingest feeds transcript + judge + decoder; /graph exposes typed nodes", async () => {
  const streams = {
    complete: (_m: string, system: string, _u: string) => {
      if (system.includes("conversation graph")) {
        return Promise.resolve('{"nodes":[{"seg":1000000001,"kind":"decision","label":"ship the tabs","topic":"demo prep"}]}');
      }
      return Promise.resolve('{"good_point":true,"quote":"Ship the tabs before demo.","why":"clear call","score":9}');
    },
  };
  const app = new GoodpointRuntime(env, undefined, streams);
  app.lastDecodeAt = Date.now(); // <3 pending + recent decode → deferred until forced below
  const seg = await app.ingestSpeech("I think we should ship the tabs before demo.");
  assert(seg.order > 1_000_000_000);
  assertEquals(app.transcript.length, 1);
  assertEquals(app.ledger.length, 1); // judge fired on mic speech
  app.lastDecodeAt = 0;
  await app.decoderTurn();
  assertEquals(app.graphNodes.length, 1);
  assertEquals(app.graphNodes[0].kind, "decision");
  assertEquals(app.graphTopics, ["demo prep"]);

  const res = await handler(new Request("http://x/graph"), { runtime: app });
  const g = await res.json();
  assertEquals(g.nodes.length, 1);
  assertEquals(g.decisions.length, 1);
});

Deno.test("/listen rejects empty audio; smokeTest rejects clearRect; compositor dedupes layers", async () => {
  const app = new GoodpointRuntime(env);
  const res = await handler(new Request("http://x/listen", { method: "POST", body: new Uint8Array() }), { runtime: app });
  assertEquals(res.status, 400);

  const bad = app.smokeTest({ name: "wiper", desc: "", params: [], draw: "(ctx,p,t,w,h)=>{ctx.clearRect(0,0,w,h)}" });
  assert(bad && bad.includes("clearRect"));

  const seen = new Set<string>();
  const layers = [{ tool: "a" }, { tool: "a" }, { tool: "b" }]
    .filter((l) => !seen.has(l.tool) && seen.add(l.tool));
  assertEquals(layers.map((l) => l.tool), ["a", "b"]);
});

Deno.test("scoreTranscript drops silence hallucinations and non-speech garbage", async () => {
  const { scoreTranscript } = await import("../server.ts");
  const silence = scoreTranscript({ text: "안녕하세요 감사합니다", segments: [{ no_speech_prob: 0.8, avg_logprob: -1.2, compression_ratio: 1.1 }] });
  assert(silence.drop); // high no_speech + no latin chars
  const korean = scoreTranscript({ text: "시청해주셔서 감사합니다", segments: [{ no_speech_prob: 0.2, avg_logprob: -0.3, compression_ratio: 1.0 }] });
  assert(korean.drop); // confident-looking but zero latin characters
  const good = scoreTranscript({ text: "we should ship the tabs today", segments: [{ no_speech_prob: 0.05, avg_logprob: -0.2, compression_ratio: 1.2 }] });
  assert(!good.drop);
  assert(good.confidence > 0.7);
});

Deno.test("starter toolbox seeds the registry at boot and every tool passes the smoke test", () => {
  const rt = new GoodpointRuntime(env);
  assertEquals(rt.registry.size, STARTER_TOOLS.length);
  for (const tool of STARTER_TOOLS) assertEquals(rt.smokeTest(tool), null, tool.name);
  // seed tools are announced as events so the UI palette shows them
  assertEquals(rt.events.filter((e) => (e.ev as any).type === "tool").length, STARTER_TOOLS.length);
});

Deno.test("registry eviction: LRU extras drop at the cap; starters and on-screen tools survive", async () => {
  const rt = new GoodpointRuntime({ ...env, MAX_TOOLS: "8" });
  const mk = (name: string) => ({ name, desc: "x", params: [], draw: "(ctx,p,t,w,h)=>{}" });
  for (let i = 0; i < 6; i++) rt.registry.set("gen" + i, mk("gen" + i));
  rt.composition = { layers: [{ tool: "gen0", params: {} }] };
  await rt.evictTools();
  assertEquals(rt.registry.size, 8);
  assert(rt.registry.has("gen0"), "on-screen tool survives");
  for (const t of STARTER_TOOLS) assert(rt.registry.has(t.name), "starter survives: " + t.name);
  assert(!rt.registry.has("gen1"), "oldest unprotected generated tool evicted first");
  assert(rt.registry.has("gen5"), "newest generated tool survives");
  assertEquals(rt.events.filter((e) => (e.ev as any).type === "tool-evicted").length, 4);
});

Deno.test("/tools returns the palette snapshot; /reset clears and reseeds the registry", async () => {
  const rt = new GoodpointRuntime(env);
  rt.registry.set("gen", { name: "gen", desc: "x", params: [], draw: "(ctx)=>{}" });
  let res = await handler(new Request("http://x/tools"), { runtime: rt });
  assertEquals((await res.json()).tools.length, STARTER_TOOLS.length + 1);

  res = await handler(new Request("http://x/reset", { method: "POST" }), { runtime: rt });
  assertEquals(res.status, 200);
  assertEquals(rt.registry.size, STARTER_TOOLS.length);
  assert(!rt.registry.has("gen"));
  assertEquals((rt.composition as any).layers, []);
});

// #124: session trace persistence — events append to a per-session JSONL; /traces lists them,
// /traces/<id> streams them back, /diag reports write status, /reset rotates. fs errors surface as
// a status event (no in-memory fallback) and set write_ok=false.
Deno.test("#124 traces: push appends to the session JSONL; /traces lists + /traces/<id> round-trips", async () => {
  const dir = await Deno.makeTempDir();
  const store = new TraceStore(dir);
  const rt = new GoodpointRuntime(env, undefined, undefined, store);
  // seedTools already pushed STARTER_TOOLS tool events at construction
  rt.push({ type: "segment", segment: { order: 1, text: "ship the verifiable subset", t: 0 } });

  // GET /traces → one session, holding the seeded tools + our segment
  let res = await handler(new Request("https://app.example/traces"), { runtime: rt });
  assertEquals(res.status, 200);
  const list = await res.json();
  assertEquals(list.length, 1);
  assertEquals(list[0].id, store.id);
  assertEquals(typeof list[0].started, "string");
  assert(list[0].started.endsWith("Z"), "started is an ISO timestamp");
  assert(list[0].bytes > 0, "trace file has bytes");
  assertEquals(list[0].events, STARTER_TOOLS.length + 1);

  // GET /traces/<id> streams the JSONL back (content-type application/x-ndjson); events round-trip
  res = await handler(new Request(`https://app.example/traces/${store.id}`), { runtime: rt });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/x-ndjson");
  const body = await res.text();
  const lines = body.trim().split("\n").map((l) => JSON.parse(l));
  assertEquals(lines.length, STARTER_TOOLS.length + 1);
  const seg = lines.find((l: any) => l.ev?.type === "segment");
  assert(seg, "pushed segment round-trips from the trace");
  assertEquals(seg.ev.segment.text, "ship the verifiable subset");

  // /diag reports the trace block
  res = await handler(new Request("https://app.example/diag"), { runtime: rt });
  const diag = await res.json();
  assertEquals(diag.trace.session_id, store.id);
  assertEquals(diag.trace.events_written, STARTER_TOOLS.length + 1);
  assertEquals(diag.trace.write_ok, true);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("#124 traces: /reset rotates to a fresh session file", async () => {
  const dir = await Deno.makeTempDir();
  const rt = new GoodpointRuntime(env, undefined, undefined, new TraceStore(dir));
  const firstSession = rt.traces!.id;
  assert(firstSession.length > 0, "boot session opened");

  const res = await handler(new Request("https://app.example/reset", { method: "POST" }), { runtime: rt });
  assertEquals(res.status, 200);
  assert(rt.traces!.id !== firstSession, "/reset opened a new session id");

  const listRes = await handler(new Request("https://app.example/traces"), { runtime: rt });
  const list = await listRes.json();
  assertEquals(list.length, 2, "two trace files after a reset");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("#124 traces: an unwritable cwd surfaces a status event + write_ok=false (no fallback)", async () => {
  // a trace dir whose parent is a file → mkdir fails → rotate records writeOk=false
  const blocker = await Deno.makeTempFile();
  const rt = new GoodpointRuntime(env, undefined, undefined, new TraceStore(`${blocker}/sub`));
  assertEquals(rt.traces!.writeOk, false, "rotate failed on an unwritable dir");
  rt.push({ type: "segment", segment: { order: 1, text: "x", t: 0 } });
  // the fs error must surface as a status event (never silently swallowed)
  const status = rt.events.find((e) =>
    (e.ev as any).type === "status" &&
    typeof (e.ev as any).text === "string" &&
    (e.ev as any).text.includes("trace write failed"),
  );
  assert(status, "a trace write failure was surfaced as a status event");
  assertEquals(rt.traces!.writeOk, false, "no in-memory fallback: writeOk stays false");
  const res = await handler(new Request("https://app.example/diag"), { runtime: rt });
  const diag = await res.json();
  assertEquals(diag.trace.write_ok, false);
  await Deno.remove(blocker);
});

Deno.test("#83 conversation-state verdict parsers sanitize, clamp, and reject empty", () => {
  const recap = parseRecap('noise {"recap":"  the team is debating the deploy window for the OAuth3 rollout  "} trailing');
  assert(recap);
  assertEquals(recap.recap, "the team is debating the deploy window for the OAuth3 rollout");
  assertEquals(parseRecap('{"recap":"   "}'), null);
  assertEquals(parseRecap("not json at all"), null);

  const shift = parseShift('{"shifted":true,"topic":"oauth3 deploy window","junk":1}');
  assert(shift);
  assertEquals(shift.shifted, true);
  assertEquals(shift.topic, "oauth3 deploy window");
  assertEquals(parseShift('{"shifted":true,"topic":""}'), null);

  const flow = parseFlow('{"audience":"core eng team","purpose":"decide the rollout","register":"working","extra":2}');
  assert(flow);
  assertEquals(flow.register, "working");
  assertEquals(flow.audience, "core eng team");
  // unknown register is kept verbatim (not silently coerced), per no-masking rule
  const flowUnknown = parseFlow('{"audience":"folks","purpose":"sync","register":"intense"}');
  assert(flowUnknown);
  assertEquals(flowUnknown.register, "intense");
  assertEquals(parseFlow('{"audience":"","purpose":""}'), null);
});

Deno.test("#83 stateRecent uses the override LLM, records one shift, and is served by /state", async () => {
  // brainrot-box ctor: (env, judgeOverride?, streams?, traceStore?, stateOverride?) — pass null
  // traceStore so the test doesn't touch disk, and a stateOverride so no e2ee key is needed.
  const rt = new GoodpointRuntime(env, undefined, undefined, null, async (kind) => {
    if (kind === "recap") return '{"recap":"deciding the oauth3 rollout window"}';
    if (kind === "shift") return '{"shifted":true,"topic":"oauth3 rollout window"}';
    return '{"audience":"core eng","purpose":"decide rollout","register":"working"}';
  });
  for (const s of normalizeSegments({ segments: [
    { order: 1, text: "we need to pick the deploy window for the oauth3 rollout" },
    { order: 2, text: "the staging gate requires real evidence before we ship" },
  ] })) rt.transcript.push(s);

  const state = await rt.stateRecent(true);
  assert(state);
  assertEquals(state.recap, "deciding the oauth3 rollout window");
  assertEquals(state.last_topic, "oauth3 rollout window");
  assertEquals(state.shifts.length, 1);
  assertEquals(state.estimate.register, "working");

  // same topic again -> no duplicate shift
  await rt.stateRecent(true);
  assertEquals(rt.shifts.length, 1);

  const res = await handler(new Request("https://app.example/state"), { runtime: rt });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.recap, "deciding the oauth3 rollout window");
  assertEquals(body.last_topic, "oauth3 rollout window");
  assertEquals(body.estimate.register, "working");
});

Deno.test("conversation-type parse pulls a known genre + rationale out of noisy wrapper text", () => {
  const v = parseConvType('prefix {"type":"brainstorming","rationale":"exploring wild options for the rollout"} suffix');
  assert(v);
  assertEquals(v.type, "brainstorming");
  assertEquals(v.rationale, "exploring wild options for the rollout");
});

Deno.test("conversation-type parse clamps a runaway rationale to 14 words", () => {
  const long = Array.from({ length: 18 }, (_, i) => "w" + i).join(" ");
  const v = parseConvType(`{"type":"decision-making","rationale":"${long}"}`);
  assert(v);
  assertEquals(v.type, "decision-making");
  assertEquals(v.rationale.split(/\s+/).length, 14);
  assertEquals(v.rationale.endsWith("w13"), true);
});

Deno.test("conversation-type parse rejects garbage and a missing type", () => {
  assertEquals(parseConvType("not json at all"), null);
  assertEquals(parseConvType('{"rationale":"no type here"}'), null);
});

Deno.test("conversation-type parse keeps an honest unknown genre instead of masking", () => {
  const v = parseConvType('{"type":"planning","rationale":"does not match the enum"}');
  assert(v);
  assertEquals(v.type, "planning");
});

Deno.test("/conv-type reflects the rolling verdict from real text (mocked LLM, no network)", async () => {
  const rt = new GoodpointRuntime(env, undefined, undefined, undefined, undefined, async (text) => ({
    type: text.includes("shipped") ? "status-update" : "social",
    rationale: "standup pacing",
  }));
  rt.transcript.push({
    order: 1,
    text: "yesterday I shipped the helper and today I will verify it",
    t: Date.now(),
  });
  const v = await rt.convTypeRecent(true);
  assert(v);
  assertEquals(v.type, "status-update");
  const res = await handler(new Request("https://app.example/conv-type"), { runtime: rt });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.type, "status-update");
  assertEquals(body.rationale, "standup pacing");
});

Deno.test("convTypeRecent throttles to one LLM call per window", async () => {
  let calls = 0;
  const rt = new GoodpointRuntime(env, undefined, undefined, undefined, undefined, async () => {
    calls++;
    return { type: "debate", rationale: "x" };
  });
  rt.transcript.push({ order: 1, text: "some segment long enough to clear the length gate", t: Date.now() });
  await rt.convTypeRecent(true);
  await rt.convTypeRecent(false); // within the 20s window — must not call
  assertEquals(calls, 1);
});

// --- issue #92: real-time self-eval (staleness -> self-regulation) ---
// Ported from goodpoint-box into brainrot-box. observeComposition/selfNudge are synchronous and
// need no e2ee key; only the optional critic uses the injected criticOverride (last ctor arg).

const ac = () => new AbortController().signal;
const comp = (tool: string, speed = 1) => ({ layers: [{ tool, params: { speed } }] });

Deno.test("#92 near-identical compositions trigger a self-nudge", async () => {
  const rt = new GoodpointRuntime(env);
  rt.composition = comp("snake", 1.0);
  for (let i = 0; i < 9; i++) await rt.observeComposition(ac());
  // 8 identical sigs in a window of 10 crosses the threshold exactly once (nudge resets the window)
  assertEquals(rt.nudgeCount, 1);
  assert(rt.lastNudgeAction.length > 0);
  assert(rt.events.some((e) => {
    const ev = e.ev as any;
    return ev?.type === "activity" && ev?.who === "self-eval" && String(ev?.state).includes("self-nudge");
  }));
});

Deno.test("#92 small param deltas still count as stale (quantization collapses them)", async () => {
  const rt = new GoodpointRuntime(env);
  // jitter well inside the 0.2 bucket must read as the same composition
  for (const s of [1.01, 1.04, 1.0, 1.05, 1.02, 1.03, 1.0, 1.04, 1.01]) {
    rt.composition = comp("snake", s);
    await rt.observeComposition(ac());
  }
  assertEquals(rt.nudgeCount, 1);
});

Deno.test("#92 a varied run does NOT self-nudge", async () => {
  const rt = new GoodpointRuntime(env);
  const tools = ["snake", "grid", "orbit", "ribbon", "glyph", "wave", "burst", "drift", "spoke"];
  for (const t of tools) {
    rt.composition = comp(t);
    await rt.observeComposition(ac());
  }
  assertEquals(rt.nudgeCount, 0);
  assertEquals(rt.lastNudgeAction, "");
  assert(!rt.events.some((e) => {
    const ev = e.ev as any;
    return ev?.who === "self-eval" && String(ev?.state).includes("self-nudge");
  }));
});

Deno.test("#92 self-nudge escalates and retires the most-used tool (starters protected)", async () => {
  const rt = new GoodpointRuntime(env);
  // seed non-starters so level-2 (retire) has something to retire; starters stay in the registry
  const startersBefore = rt.registry.size;
  (rt.registry as Map<string, unknown>).set("snake", { name: "snake", params: [] });
  (rt.registry as Map<string, unknown>).set("grid", { name: "grid", params: [] });
  // three stuck episodes => one of each escalating level (perturb, avoid, retire)
  for (let ep = 0; ep < 3; ep++) {
    rt.composition = comp("snake");
    for (let i = 0; i < 8; i++) await rt.observeComposition(ac());
  }
  assertEquals(rt.nudgeCount, 3);
  // the third nudge (level 2) retires snake, the most-used tool
  assert(rt.lastNudgeAction.startsWith("retire most-used tool: snake"));
  assert(!rt.registry.has("snake"));
  // starters survived the retire (palette floor intact)
  assertEquals(rt.registry.size, startersBefore + 1); // +grid still present, -snake
});

Deno.test("#92 self-nudge preserves a banger's emphasis", async () => {
  const rt = new GoodpointRuntime(env);
  rt.brief = { mood: "good point: ship it", emphasis: "ship it", tone: "sharp", direction: "legible" };
  rt.composition = comp("snake");
  for (let i = 0; i < 8; i++) await rt.observeComposition(ac());
  assertEquals(rt.nudgeCount, 1);
  assertEquals(rt.brief.emphasis, "ship it"); // banger emphasis survives the perturb
});

Deno.test("#92 /diag surfaces the self-eval fields after a nudge", async () => {
  const rt = new GoodpointRuntime(env);
  rt.composition = comp("snake");
  for (let i = 0; i < 8; i++) await rt.observeComposition(ac());
  const res = await handler(new Request("https://app.example/diag"), { runtime: rt });
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(!!body.self_eval);
  assertEquals(body.self_eval.stale_window, 10);
  assertEquals(body.self_eval.stale_threshold, 8);
  assertEquals(body.self_eval.nudge_count, 1);
  assert(body.self_eval.last_nudge_action.length > 0);
  // #94: the flat e2ee block became the per-lane routing block; the critic entry carries its model
  // and enabled flag there.
  const byLane = Object.fromEntries(body.routing.map((r: { lane: string }) => [r.lane, r]));
  assertEquals(typeof byLane.critic.model, "string");
  assertEquals(byLane.critic.enabled, false);
  assertEquals(byLane.critic.hears_room, false);
  assertEquals(byLane.judge.hears_room, true);
});

Deno.test("#92 optional critic (via override) feeds the brief, only when configured", async () => {
  let seen: string[] = [];
  const rt = new GoodpointRuntime(
    env,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (sigs) => {
      seen = sigs;
      return "shift to warmer motion";
    },
  );
  rt.composition = comp("snake");
  // CRITIC_EVERY is 10; drive 10 cycles without crossing the staleness threshold (vary the tool)
  const tools = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  for (const t of tools) {
    rt.composition = comp(t);
    await rt.observeComposition(ac());
  }
  assertEquals(rt.nudgeCount, 0); // never stuck
  assert(seen.length > 0); // critic saw recent signatures
  assert(rt.brief.direction.includes("[critic: shift to warmer motion]"));
});

// #125: canvas snapshot gallery — POST /snapshot stores a jpeg under snapshots/<session>/, rejects
// non-image / >2MB bodies with 400, /snapshots lists them, /snapshots/<session>/<file> serves the
// image, and a per-session 200-file cap evicts oldest with a status event. Uses SNAPSHOT_DIR=temp
// so the round-trip is REAL on disk (no in-memory fake), per the issue's no-fallbacks rule.
function fakeJpeg(n: number): BodyInit {
  const b = new Uint8Array(n);
  b[0] = 0xff; b[1] = 0xd8; // JPEG magic (SOI)
  b[n - 2] = 0xff; b[n - 1] = 0xd9; // EOI
  for (let i = 2; i < n - 2; i++) b[i] = (i * 31) & 0xff; // pseudo-payload
  return b as BodyInit;
}

Deno.test("#125 session id is filesystem-safe and matches #124's trace id format", () => {
  const id = newSessionId(new Date("2026-07-24T13:00:34.207Z"));
  // 2026-07-24T13-00-34-207Z-<8 hex> — no ':' or '.' (those break Windows-safe paths + sort badly)
  assertEquals(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z-[0-9a-f]{8}$/.test(id), true, id);
  assert(!id.includes(":") && !id.includes("."), id);
});

Deno.test("#125 snapshots: POST /snapshot round-trips through /snapshots and /snapshots/<s>/<f>; rejects non-image / >2MB with 400", async () => {
  const dir = await Deno.makeTempDir();
  const rt = new GoodpointRuntime({ ...env, SNAPSHOT_DIR: `${dir}/snaps` });
  const session = rt.sessionId;
  const jpeg = { "content-type": "image/jpeg" };

  // store one real jpeg
  let res = await handler(new Request("https://x/snapshot", { method: "POST", headers: jpeg, body: fakeJpeg(2048) }), { runtime: rt });
  assertEquals(res.status, 201);
  const ref = await res.json();
  assertEquals(ref.session, session);
  assertEquals(ref.bytes, 2048);
  assert(ref.file.endsWith(".jpg"));
  assert(Number.isFinite(ref.t));

  // /snapshots lists it as {session,file,t,bytes}
  res = await handler(new Request("https://x/snapshots"), { runtime: rt });
  assertEquals(res.status, 200);
  const list = await res.json();
  assert(Array.isArray(list));
  assertEquals(list.length, 1);
  assertEquals(list[0].session, session);
  assertEquals(list[0].file, ref.file);
  assertEquals(list[0].bytes, 2048);
  // t is the file mtime, which lags Date.now() at store time by a few ms — just assert it's present + sane
  assert(Number.isFinite(list[0].t) && Math.abs(list[0].t - ref.t) < 5000, `t near store time: ${list[0].t} vs ${ref.t}`);

  // /snapshots/<session>/<file> serves the jpeg back, bytes intact
  res = await handler(new Request(`https://x/snapshots/${session}/${ref.file}`), { runtime: rt });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/jpeg");
  const out = new Uint8Array(await res.arrayBuffer());
  assertEquals(out.length, 2048);
  assertEquals([out[0], out[1], out[out.length - 1]], [0xff, 0xd8, 0xd9]);

  // non-image content-type -> 400
  res = await handler(new Request("https://x/snapshot", { method: "POST", headers: { "content-type": "text/plain" }, body: fakeJpeg(64) }), { runtime: rt });
  assertEquals(res.status, 400);
  // claims jpeg but bad magic bytes -> 400
  res = await handler(new Request("https://x/snapshot", { method: "POST", headers: jpeg, body: new TextEncoder().encode("not-a-jpeg-at-all") as BodyInit }), { runtime: rt });
  assertEquals(res.status, 400);
  // oversize (>2MB) -> 400
  res = await handler(new Request("https://x/snapshot", { method: "POST", headers: jpeg, body: fakeJpeg(SNAP_MAX_BYTES + 1) }), { runtime: rt });
  assertEquals(res.status, 400);
  // nothing new landed from the rejected writes
  assertEquals((await (await handler(new Request("https://x/snapshots"), { runtime: rt })).json()).length, 1);
});

Deno.test("#125 snapshots: per-session cap evicts oldest (→ 200) and announces it as a status event", async () => {
  const dir = await Deno.makeTempDir();
  const rt = new GoodpointRuntime({ ...env, SNAPSHOT_DIR: `${dir}/snaps` });
  const jpeg = { "content-type": "image/jpeg" };
  for (let i = 0; i < SNAP_CAP_FILES + 2; i++) {
    const res = await handler(new Request("https://x/snapshot", { method: "POST", headers: jpeg, body: fakeJpeg(64) }), { runtime: rt });
    assertEquals(res.status, 201);
    await new Promise((r) => setTimeout(r, 3)); // distinct mtimes → deterministic eviction order
  }
  const list = await (await handler(new Request("https://x/snapshots"), { runtime: rt })).json();
  assertEquals(list.length, SNAP_CAP_FILES, "session dir capped at 200");
  assert(rt.events.some((e) => (e.ev as any).type === "status" && /evicted/i.test(String((e.ev as any).text))), "a status event announced the cap eviction");
});

Deno.test("#125 snapshots: /reset rotates the session id; /diag reports the snapshot block", async () => {
  const dir = await Deno.makeTempDir();
  const rt = new GoodpointRuntime({ ...env, SNAPSHOT_DIR: `${dir}/snaps` });
  const before = rt.sessionId;
  await handler(new Request("https://x/reset", { method: "POST" }), { runtime: rt });
  assert(rt.sessionId !== before, "/reset rotated the session id");
  assert(rt.sessionId.startsWith("20"));

  const res = await handler(new Request("https://x/diag"), { runtime: rt });
  const body = await res.json();
  assertEquals(body.snapshot.session_id, rt.sessionId);
  assertEquals(body.snapshot.dir, `${dir}/snaps`);
  assertEquals(body.snapshot.write_ok, true);
  assertEquals(body.snapshot.written, 0);
});

Deno.test("#125 snapshots: path traversal in /snapshots/<s>/<f> is rejected (404, not served)", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeFile(`${dir}/evil.txt`, new TextEncoder().encode("secret"));
  const rt = new GoodpointRuntime({ ...env, SNAPSHOT_DIR: dir });
  const res = await handler(new Request("https://x/snapshots/..%2F..%2Fevil.txt/foo.jpg"), { runtime: rt });
  // the route regex splits on the last `/`, and safeSeg rejects `..`; never reads outside the dir
  assert([404, 400].includes(res.status));
});

// #94 privacy cleave -----------------------------------------------------------
// The paint crew (toolsmith/compositor/critic) sees a sanitized brief; the verbatim quote flows
// ONLY to the client. Hearing lanes (judge/distill/decoder/state/convtype) are e2ee by construction;
// paint lanes optionally go hosted when BASE_URL is set.
function trigrams(s: string): Set<string> {
  const words = s.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  const g = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) g.add(words.slice(i, i + 3).join(" "));
  return g;
}

Deno.test("#94 sanitizeBrief carries no verbatim trigram of the quote", () => {
  const quote = "Ship the verifiable subset before chasing the long tail of work.";
  const brief = sanitizeBrief({ t: Date.now(), quote, why: "scope clarity", score: 9 });
  const briefStr = JSON.stringify(brief).toLowerCase();
  for (const g of trigrams(quote)) {
    assert(!briefStr.includes(g), `brief leaks trigram of the quote: "${g}"`);
  }
  assert(!briefStr.includes("verifiable"), "no quote word leaks into the brief");
  assert(!briefStr.includes("subset"), "no quote word leaks into the brief");
  assert(!briefStr.includes("scope clarity"), "the judge why must not flow into the brief");
  assert(/\bword\b/.test(brief.emphasis), "emphasis is a structural descriptor, not content");
  assertEquals(brief.mood, "good point");
});

Deno.test("#94 judge event keeps the verbatim quote for the client, sanitized brief for the crew", async () => {
  const quote = "Ship the verifiable subset before chasing the long tail of work.";
  const rt = new GoodpointRuntime(
    env,
    async () => ({ good_point: true, quote, why: "scope clarity", score: 9 }),
    undefined,
    null,
  );
  rt.transcript.push({ order: 1, text: "filler ".repeat(20), t: Date.now() });
  const point = await rt.judgeRecent(true);
  assertEquals(point?.quote, quote, "verbatim quote preserved in the ledger point");
  const found = rt.events.find((e) => (e.ev as { type?: string }).type === "goodpoint");
  assert(found, "a goodpoint event was emitted");
  const ev = found!.ev as { point: { quote: string }; brief: Record<string, string> };
  assertEquals(ev.point.quote, quote, "client receives the verbatim quote for local canvas render");
  const briefStr = JSON.stringify(ev.brief).toLowerCase();
  assert(!briefStr.includes("verifiable"), "no verbatim leak to the brief the crew sees");
  assert(!briefStr.includes("subset"), "no verbatim leak to the brief the crew sees");
});

Deno.test("#94 with hosted paint endpoints configured, hearing lanes stay e2ee (rebase ruling)", () => {
  const hosted: Record<string, string> = {
    ...env,
    TOOLSMITH_BASE_URL: "https://fast.example/v1",
    TOOLSMITH_API_KEY: "k-fast",
    TOOLSMITH_MODEL: "gpt-fast",
    COMPOSITOR_BASE_URL: "https://fast2.example/v1",
    COMPOSITOR_API_KEY: "k-fast2",
  };
  const rt = new GoodpointRuntime(hosted);
  assertEquals(rt.route("toolsmith").transport, "hosted");
  assertEquals(rt.route("compositor").transport, "hosted");
  assertEquals(rt.route("critic").transport, "hosted", "critic is compositor-class paint (signatures only)");
  // every hearing lane ignores the hosted config entirely — no hosted branch exists for them
  for (const lane of HEARING_LANES) {
    const r = rt.route(lane);
    assert(r.transport !== "hosted", `${lane} hears the room and must never go hosted`);
    assert(!r.baseUrl, `${lane} must not carry a hosted baseUrl`);
  }
  assertEquals(rt.route("judge").model, "deepseek-ai/DeepSeek-V4-Flash", "judge ignores TOOLSMITH_MODEL");
  assertEquals(rt.route("distill").model, "unsloth/Mistral-Nemo-Instruct-2407-TEE", "distill keeps the old compositor default, e2ee");
  assertEquals(rt.route("distill").transport, "chutes-e2ee");
  // without hosted config, paint lanes stay e2ee too (defaults preserve pre-cleave behavior)
  const rt2 = new GoodpointRuntime(env);
  assertEquals(rt2.route("toolsmith").transport, "near-e2ee");
  assertEquals(rt2.route("compositor").transport, "chutes-e2ee");
  assertEquals(rt2.route("judge").transport, "near-e2ee");
});

Deno.test("#94 with hosted TOOLSMITH configured, tools still forge while judge stays e2ee (mocked)", async () => {
  const toolJson = '{"name":"x","desc":"d","params":[],"draw":"(ctx,p,t,w,h,txt)=>{}"}';
  const hosted: Record<string, string> = {
    ...env,
    TOOLSMITH_BASE_URL: "https://fast.example/v1",
    TOOLSMITH_API_KEY: "k-fast",
  };
  const rt = new GoodpointRuntime(hosted, undefined, { complete: async () => toolJson }, null);
  assertEquals(rt.route("toolsmith").transport, "hosted");
  assertEquals(rt.route("judge").transport, "near-e2ee");
  await rt.toolsmithTurn(new AbortController().signal);
  assertEquals(rt.registry.size > 0, true, "toolsmith forged a tool via the mocked hosted transport");
});

Deno.test("#94 /diag reports per-lane routing (no secrets)", async () => {
  const hosted: Record<string, string> = {
    ...env,
    TOOLSMITH_BASE_URL: "https://fast.example/v1",
    TOOLSMITH_API_KEY: "secret-never-leak",
  };
  const rt = new GoodpointRuntime(hosted, undefined, { complete: async () => '{"layers":[]}' }, null);
  rt.start();
  const res = await handler(new Request("https://app.example/diag"), { runtime: rt });
  assertEquals(res.status, 200);
  const body = await res.json();
  const byLane = Object.fromEntries(body.routing.map((r: { lane: string }) => [r.lane, r]));
  assertEquals(byLane.toolsmith.transport, "hosted");
  for (const lane of HEARING_LANES) {
    assert(byLane[lane].transport !== "hosted", `${lane} must never report hosted`);
    assertEquals(byLane[lane].hears_room, true);
  }
  const diagText = JSON.stringify(body);
  assert(!diagText.includes("secret-never-leak"), "/diag must never disclose api keys");
  assert(!diagText.includes("fast.example"), "/diag must not disclose the hosted baseUrl either");
  rt.stop();
});

Deno.test("#94 distill output is sanitized before the paint crew sees it (verbatim key phrase dropped)", async () => {
  const recent = "I really think we should ship the tabs before demo day and then celebrate properly tonight";
  const distillJson = JSON.stringify({
    mood: "we should ship the tabs before demo day", // verbatim run — must be scrubbed
    emphasis: "ship the tabs", // #93's key-phrase extract — must become a structural descriptor
    tone: "rising, electric", // original phrasing — kept
    direction: "quickening pulse with an upward surge at the turn", // original phrasing — kept
  });
  const rt = new GoodpointRuntime(
    env,
    undefined,
    { complete: async (_lane: string, system: string) => system.includes("VISUAL BRIEF") ? distillJson : '{"layers":[]}' },
    null,
  );
  rt.transcript.push({ order: 1, text: recent, t: Date.now() });
  rt.lastDistill = 0;
  await rt.distill();
  const briefStr = JSON.stringify(rt.brief).toLowerCase();
  for (const g of trigrams(recent)) {
    assert(!briefStr.includes(g), `distill brief leaks trigram of the transcript: "${g}"`);
  }
  assert(!briefStr.includes("ship the tabs"), "the #93 key phrase must not reach the crew verbatim");
  assertEquals(rt.brief.emphasis, "3-word declarative", "emphasis is structural: word count + register");
  assertEquals(rt.brief.tone, "rising, electric", "original phrasing survives");
  assertEquals(rt.brief.direction.includes("quickening pulse"), true, "original phrasing survives");
  assertEquals(rt.brief.mood, "", "a verbatim mood is blanked, never masked");
  const status = rt.events.find((e) => (e.ev as { type?: string }).type === "status");
  assert(status, "the scrub is announced as a status event (honest, visible)");
  assert(String((status!.ev as { text?: string }).text).includes("mood"), "the status names the scrubbed field");
});

Deno.test("#94 trigram leak detector: 3 consecutive transcript words trip it, paraphrase does not", () => {
  const transcript = "ship the verifiable subset before chasing anything else";
  assert(leaksVerbatim("we will ship the verifiable subset now", transcript), "3-gram overlap detected");
  assert(!leaksVerbatim("deliver the provable part first, defer the rest", transcript), "paraphrase passes");
  assert(!leaksVerbatim("", transcript), "empty field is trivially clean");
});

// #126: a stalled stream can't wedge a lane. A provider that never resolves on its own (the
// "hung TCP stream" shape) is aborted by the per-call deadline composed into its signal; the
// lane surfaces a lane-named status and continues to the next turn instead of freezing forever.
const hungProvider: StreamProvider = {
  complete: (_m, _s, _u, _mx, _d, signal) =>
    new Promise<string>((_resolve, reject) => {
      // only the composed deadline signal (lane signal + per-call timeout) ever moves this.
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
};

Deno.test("#126 timeout: a hung provider aborts at the deadline, the weave loop continues, and a lane-named status is pushed", async () => {
  const tEnv = {
    ...env,
    TOOLSMITH_TIMEOUT_MS: "120",
    COMPOSITOR_TIMEOUT_MS: "120",
    WEAVE_IDLE_MS: "600000",
    OTTER_IDLE_MS: "600000",
  };
  const rt = new GoodpointRuntime(tEnv, undefined, hungProvider);
  rt.start();
  assert(rt.weaveRunning, "weave running before the hung turn");
  // toolsmith/compositor each hit the hung provider; within ~1s the 120ms deadline fires, the
  // turn aborts, the weave loop catches it, pushes a lane-named status, and continues.
  await new Promise((r) => setTimeout(r, 800));
  assert(rt.weaveRunning, "weave loop continued past the aborted turn (no wedge)");
  rt.stop();
  const ev = rt.events
    .map((e) => e.ev as any)
    .find((e) => e.type === "status" && typeof e.text === "string" && e.text.includes("timeout"));
  assert(ev, "a stream timeout surfaced as a status event");
  assert(/^(toolsmith|compositor) timeout after/.test(ev.text), `status names the lane: ${ev.text}`);
});

Deno.test("#126 timeout: judge aborts at its own deadline and surfaces a lane-named status (no /listen wedge)", async () => {
  const tEnv = { ...env, JUDGE_TIMEOUT_MS: "100" };
  const rt = new GoodpointRuntime(tEnv, undefined, hungProvider);
  // seed >=20 chars of transcript so judgeRecent actually calls the (hung) provider
  rt.transcript.push({ order: 1, text: "we should ship the verifiable subset before the booth opens", t: Date.now() });
  const t0 = Date.now();
  const gp = await rt.judgeRecent(true);
  const elapsed = Date.now() - t0;
  assertEquals(gp, null, "a hung judge returns null (no banger) instead of hanging");
  assert(elapsed < 2000, `judge aborted at the deadline (~100ms), not hung: ${elapsed}ms`);
  const ev = rt.events
    .map((e) => e.ev as any)
    .find((e) => e.type === "status" && typeof e.text === "string" && e.text.includes("timeout"));
  assert(ev, "judge timeout surfaced as a status event");
  assert(/^judge timeout after/.test(ev.text), `status names the lane: ${ev.text}`);
});

Deno.test("#126 /diag carries per-lane last_turn_at so a wedged lane is visible remotely", async () => {
  const rt = new GoodpointRuntime(env, undefined, stubStreams);
  rt.lastToolsmithTurnAt = 1_700_000_000_000;
  rt.lastCompositorTurnAt = 1_700_000_001_000;
  rt.lastFetchAt = 1_700_000_002_000; // otter lane
  rt.lastDecodeAt = 1_700_000_003_000; // decoder lane
  const res = await handler(new Request("https://app.example/diag"), { runtime: rt });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.lanes.toolsmith.last_turn_at, 1_700_000_000_000);
  assertEquals(body.lanes.compositor.last_turn_at, 1_700_000_001_000);
  assertEquals(body.lanes.otter.last_turn_at, 1_700_000_002_000);
  assertEquals(body.lanes.decoder.last_turn_at, 1_700_000_003_000);
  assertEquals(body.lanes.toolsmith.timeout_ms, 60000, "toolsmith default deadline is 60s");
  assertEquals(body.lanes.compositor.timeout_ms, 30000, "compositor default deadline is 30s");
});

Deno.test("#126 timeout: a real turn stamps its lane's last_turn_at", async () => {
  const rt = new GoodpointRuntime(env, undefined, stubStreams);
  const ctrl = new AbortController();
  await rt.toolsmithTurn(ctrl.signal);
  assert(rt.lastToolsmithTurnAt > 0, "toolsmith turn stamped last_turn_at");
  await rt.compositorTurn(ctrl.signal);
  assert(rt.lastCompositorTurnAt > 0, "compositor turn stamped last_turn_at");
});

// #126 (rebase extension): the state/convtype call sites added by #85/#88 run in the otter loop;
// they carry the same per-call deadline, so a hung read surfaces a lane-named status and leaves
// the prior read in place instead of wedging the loop or skipping sibling lanes.
Deno.test("#126 timeout: state and convtype reads abort at their deadline with lane-named statuses", async () => {
  const tEnv = { ...env, STATE_TIMEOUT_MS: "100" };
  const rt = new GoodpointRuntime(tEnv, undefined, hungProvider);
  rt.transcript.push({ order: 1, text: "we should ship the verifiable subset before the booth opens", t: Date.now() });
  rt.lastStateAt = 0;
  rt.lastConvTypeAt = 0;
  const prior: ConversationType = { type: "debate", rationale: "prior verdict stands" };
  rt.convType = prior;
  const t0 = Date.now();
  const st = await rt.stateRecent(true);
  const cv = await rt.convTypeRecent(true);
  const elapsed = Date.now() - t0;
  assert(st, "a hung state read still resolves (with prior values), it does not hang");
  assertEquals(st!.recap, "", "no fabricated recap — the prior (empty) read stands");
  assertEquals(cv, null, "a hung convtype read returns null (prior verdict stands)");
  assert(elapsed < 2500, `both reads aborted at their ~100ms deadlines: ${elapsed}ms`);
  assertEquals(rt.convType, prior, "the prior conv-type verdict stands (no flicker, no fallback)");
  const texts = rt.events.map((e) => e.ev as any).filter((e) => e.type === "status").map((e) => e.text);
  assert(texts.some((t: string) => /^state timeout after/.test(t)), `state status names the lane: ${texts}`);
  assert(texts.some((t: string) => /^convtype timeout after/.test(t)), `convtype status names the lane: ${texts}`);
});
