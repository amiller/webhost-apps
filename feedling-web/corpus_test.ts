import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recordCorpus, getCorpus, corpusSize } from "./store.ts";

// initStore() is never called here, so corpusFile is "" and nothing touches disk. The ledger is
// module-global, so these run as one sequence rather than as independent cases.
const it = (id: string, title = "t", isShort = true) => ({ id, title, isShort });

Deno.test("corpus: records new items and reports how many were new", async () => {
  const before = corpusSize();
  assertEquals(await recordCorpus([it("a"), it("b")], 1000), 2);
  assertEquals(corpusSize(), before + 2);
});

Deno.test("corpus: is append-only and deduped by id", async () => {
  const before = corpusSize();
  // 'a' and 'b' were already seen; only 'c' is new.
  assertEquals(await recordCorpus([it("a"), it("b"), it("c")], 2000), 1);
  assertEquals(corpusSize(), before + 1);
  assertEquals(getCorpus().filter((e) => e.id === "a").length, 1, "no duplicate rows for 'a'");
});

Deno.test("corpus: keeps the FIRST time an item was seen, not the latest", () => {
  assertEquals(getCorpus().find((e) => e.id === "a")!.firstSeen, 1000);
});

Deno.test("corpus: `since` filters by firstSeen", () => {
  const ids = getCorpus(2000).map((e) => e.id);
  assert(ids.includes("c"), "c was first seen at 2000");
  assert(!ids.includes("a"), "a was first seen at 1000 and must be excluded");
});

Deno.test("corpus: skips items with no id rather than storing a blank row", async () => {
  const before = corpusSize();
  assertEquals(await recordCorpus([{ id: "", title: "x", isShort: true }], 3000), 0);
  assertEquals(corpusSize(), before);
});

Deno.test("corpus: an empty poll is a no-op", async () => {
  const before = corpusSize();
  assertEquals(await recordCorpus([], 4000), 0);
  assertEquals(corpusSize(), before);
});

Deno.test("corpus: preserves isShort so the shorts ratio is reconstructable", async () => {
  await recordCorpus([it("long1", "a regular video", false)], 5000);
  assertEquals(getCorpus().find((e) => e.id === "long1")!.isShort, false);
});
