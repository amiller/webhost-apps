import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import handler, {
  GoodpointRuntime,
  isBanger,
  mergeOtterSegments,
  normalizeSegments,
  parseJudge,
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

// #93 continuous transcript→visual-brief distillation: offline tests with a MOCKED LLM prove the
// brief updates from segments WITHOUT a banger, a banger still OVERRIDES + holds the brief, and the
// cadence throttle skips a too-soon second distill. (Live staging LLM run is operator-gated — no
// NEAR/CHUTES keys on the swarm box; the issue's acceptance explicitly permits a mocked LLM.)
const distillJson = (mood: string) => JSON.stringify({ mood, emphasis: "e", tone: "t", direction: "d" });

Deno.test("#93 distill: brief updates from transcript segments with no banger", async () => {
  const streams = { complete: async () => distillJson("focused build energy") };
  const rt = new GoodpointRuntime({ ...env, DISTILL_INTERVAL_MS: "30000", DISTILL_WINDOW_MS: "120000" }, undefined, streams);
  mergeOtterSegments(
    rt.transcript,
    normalizeSegments({ segments: [{ order: 1, text: "let us land the verifiable subset today", t: Date.now() - 5000 }] }),
    rt.seen,
  );
  assertEquals(rt.brief.mood, "");
  await rt.distillBrief(true);
  assertEquals(rt.brief.mood, "focused build energy");
  assertEquals(rt.brief.tone, "t");
  assert(rt.lastDistillAt > 0);
});

Deno.test("#93 distill: a banger overrides the brief and holds it for one interval", async () => {
  let calls = 0;
  const streams = { complete: async () => { calls++; return distillJson("distilled mood"); } };
  const bangerQuote = "Ship the verifiable subset";
  const judgeOverride = async (_text: string) => ({ good_point: true, quote: bangerQuote, why: "scope clarity", score: 9 });
  const rt = new GoodpointRuntime({ ...env, DISTILL_INTERVAL_MS: "30000", DISTILL_WINDOW_MS: "120000" }, judgeOverride, streams);
  mergeOtterSegments(
    rt.transcript,
    normalizeSegments({ segments: [{ order: 1, text: "we agree to ship the verifiable subset right now", t: Date.now() - 3000 }] }),
    rt.seen,
  );
  const banger = await rt.judgeRecent(true);
  assert(banger, "banger fired");
  assertEquals(rt.brief.emphasis, bangerQuote);
  assertEquals(rt.brief.mood, `good point: ${bangerQuote}`);
  assert(rt.lastBangerAt > 0);
  // distill must be HELD by the banger — it must not call the model, and the brief must not change
  const beforeCalls = calls;
  await rt.distillBrief(true);
  assertEquals(calls, beforeCalls, "distill skipped: banger is the priority path");
  assertEquals(rt.brief.emphasis, bangerQuote, "brief still the banger's");
});

Deno.test("#93 distill: cadence throttle skips a too-soon second distill (force=false)", async () => {
  let calls = 0;
  const streams = { complete: async () => { calls++; return distillJson(`m${calls}`); } };
  const rt = new GoodpointRuntime({ ...env, DISTILL_INTERVAL_MS: "30000", DISTILL_WINDOW_MS: "120000" }, undefined, streams);
  mergeOtterSegments(
    rt.transcript,
    normalizeSegments({ segments: [{ order: 1, text: "some recent speech that is long enough to distill well", t: Date.now() - 4000 }] }),
    rt.seen,
  );
  await rt.distillBrief(false);
  assertEquals(calls, 1);
  assertEquals(rt.brief.mood, "m1");
  // immediately again, well within the 30s interval -> skipped (no second model call)
  await rt.distillBrief(false);
  assertEquals(calls, 1, "second distill within the interval was skipped");
  assertEquals(rt.brief.mood, "m1");
});
