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
