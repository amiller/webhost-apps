import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildRoastPrompt, renderRoast, draftTweet } from "./roast.ts";

// Fixed-width titles so no title is a substring of another — "title-099" present cannot be
// faked by "title-0991" matching.
const TITLES = Array.from({ length: 200 }, (_, i) => `title-${String(i).padStart(3, "0")}`);

// Replaces globalThis.fetch: counts calls, returns a chosen completion. No socket is ever opened.
function stubFetch() {
  let content = "";
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, _init?: RequestInit) => {
    calls++;
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content } }] })),
    );
  }) as typeof fetch;
  return {
    set: (c: string) => { content = c; },
    calls: () => calls,
    restore: () => { globalThis.fetch = orig; },
  };
}

Deno.test("buildRoastPrompt includes at most 40 titles when given 200", () => {
  const { sys, user } = buildRoastPrompt(TITLES);
  const present = TITLES.filter((t) => (sys + user).includes(t));
  assertEquals(present.length, 40);
  // The 40 kept are the most recent (rawHistory is recency-ordered, position 0 first).
  assertEquals(present[0], "title-000");
  assertEquals(present[39], "title-039");
});

Deno.test("buildRoastPrompt output contains no API key and no endpoint URL", () => {
  const { sys, user } = buildRoastPrompt(TITLES);
  assert(!/sk-or|Bearer|Authorization/i.test(sys + user), "prompt names a credential");
  assert(!/openrouter|https?:\/\//i.test(sys + user), "prompt names an endpoint URL");
});

Deno.test("renderRoast returns the stub's content and holds the daily cache unless forced", async () => {
  const s = stubFetch();
  try {
    s.set("roast alpha");
    assertEquals(await renderRoast(TITLES, "sk-or-test", "test/model", true), "roast alpha");
    assertEquals(s.calls(), 1);
    s.set("roast beta"); // a same-day call must not reach the model again
    assertEquals(await renderRoast(TITLES, "sk-or-test", "test/model"), "roast alpha");
    assertEquals(s.calls(), 1);
    assertEquals(await renderRoast(TITLES, "sk-or-test", "test/model", true), "roast beta");
    assertEquals(s.calls(), 2);
  } finally { s.restore(); }
});

Deno.test("draftTweet truncates a 400-character model reply to ≤280 on a word boundary", async () => {
  // 6-char groups ("abcde "): index 279 falls inside the word "abcde" starting at 276, so a
  // naive hard cut ends "...abcd" — mid-word. The fixture's last fragment makes it exactly 400.
  const fourHundred = "abcde ".repeat(66) + "abcd";
  assertEquals(fourHundred.length, 400);
  const s = stubFetch();
  try {
    s.set(fourHundred);
    const out = await draftTweet(TITLES, "sk-or-test", "test/model", true);
    assert(out.length <= 280, `len=${out.length}`);
    assert(fourHundred.startsWith(out), "output is not a prefix of the model reply");
    assert(out.endsWith("abcde"), `ends mid-word: "${out.slice(-8)}"`);
  } finally { s.restore(); }
});

Deno.test("draftTweet returns a non-empty draft for a 3-title corpus", async () => {
  const s = stubFetch();
  try {
    s.set("three videos about the same cat. bold curriculum.");
    const out = await draftTweet(
      ["cat video", "cat video", "cat video"], "sk-or-test", "test/model", true,
    );
    assert(typeof out === "string" && out.length > 0, JSON.stringify(out));
    assertEquals(out, "three videos about the same cat. bold curriculum.");
  } finally { s.restore(); }
});
