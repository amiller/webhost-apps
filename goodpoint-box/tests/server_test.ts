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
