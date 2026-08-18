// Regression test for the notification stall: YouTube's history page is a saturated ~200-item
// sliding window, so watching a new short EVICTS an older one. Detecting activity by the count of
// shorts in that window therefore reads 0 forever. shortCheck() must diff the ID set instead.
import { assertEquals } from "jsr:@std/assert";
import { configureOauth3, shortCheck } from "./oauth3-client.ts";

const WINDOW = 200;
let items: { id: string; title: string; meta: { isShort: boolean } }[] = [];

// Fake oauth3 node serving GET /api/:plugin/items.
const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
  if (new URL(req.url).pathname === "/api/youtube/items") {
    return Response.json({ data: items });
  }
  return new Response("not found", { status: 404 });
});
const node = `http://localhost:${(server.addr as Deno.NetAddr).port}`;

/** Newest-first window: unshift the new watch, drop the oldest, exactly like the history page. */
function watch(id: string, isShort: boolean) {
  items.unshift({ id, title: id, meta: { isShort } });
  items = items.slice(0, WINDOW);
}

Deno.test("count delta reads 0 while 3 new shorts arrive (the live failure)", async () => {
  // Oldest-evicted items are shorts — the live composition, where ~160 of the 200-item window are
  // shorts. Watching 3 shorts evicts 3 shorts, so the count is EXACTLY unchanged.
  items = [];
  for (let i = 0; i < 160; i++) watch(`short${i}`, true);
  for (let i = 0; i < 40; i++) watch(`video${i}`, false);
  assertEquals(items.length, WINDOW);

  configureOauth3(node, "tok", () => {});

  const first = await shortCheck();
  const baseline = first.shortsCount;
  assertEquals(first.newShorts, 0, "first poll only baselines");

  watch("fresh-a", true);
  watch("fresh-b", true);
  watch("fresh-c", true);

  const second = await shortCheck();

  // The old signal: stone blind. This is why pushes stopped.
  assertEquals(second.shortsCount - baseline, 0, "count delta is flat");
  // The new signal: sees all three.
  assertEquals(second.newShorts, 3);
  assertEquals(second.watching, true);
  assertEquals(second.shorts.map((s) => s.id).sort(), ["fresh-a", "fresh-b", "fresh-c"]);
});

Deno.test("count delta understates new shorts on a mixed window", async () => {
  items = [];
  for (let i = 0; i < WINDOW; i++) watch(`seed${i}`, i % 5 !== 0);
  configureOauth3(node, "tok", () => {});

  const first = await shortCheck();
  const baseline = first.shortsCount;
  watch("m-a", true);
  watch("m-b", true);
  watch("m-c", true);
  const second = await shortCheck();

  assertEquals(second.newShorts, 3);
  assertEquals(
    second.shortsCount - baseline < second.newShorts,
    true,
    "count delta must understate the real number of new shorts",
  );
});

Deno.test("a quiet window reports no activity", async () => {
  items = [];
  for (let i = 0; i < WINDOW; i++) watch(`q${i}`, i % 5 !== 0);
  configureOauth3(node, "tok", () => {});

  await shortCheck();
  const quiet = await shortCheck();
  assertEquals(quiet.newShorts, 0);
  assertEquals(quiet.watching, false);
});

Deno.test("a non-short watch does not count as short activity", async () => {
  items = [];
  for (let i = 0; i < WINDOW; i++) watch(`n${i}`, i % 5 !== 0);
  configureOauth3(node, "tok", () => {});

  await shortCheck();
  watch("a-real-video", false);
  const r = await shortCheck();
  assertEquals(r.newShorts, 0);
});

globalThis.addEventListener("unload", () => server.shutdown());
