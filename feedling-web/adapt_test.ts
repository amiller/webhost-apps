import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readAnswers, adapt, VARIANTS } from "./adapt.ts";
import { nagLadder } from "./state.ts";
import type { PushLogEntry } from "./store.ts";

const NOW = 1_787_500_000_000;
const DAY = 86_400_000;
const e = (trigger: string, agoDays = 0, body = "classify"): PushLogEntry =>
  ({ at: NOW - agoDays * DAY, trigger, body, sent: 1, pruned: 0, endpoints: [] });

const answers = (sg: number, ad: number, sends = 20) => readAnswers([
  ...Array.from({ length: sg }, () => e("action:still-going")),
  ...Array.from({ length: ad }, () => e("action:actually-done")),
  ...Array.from({ length: sends }, () => e("confirmed_5")),
], NOW);

Deno.test("readAnswers counts only action:* and ignores other triggers", () => {
  const a = readAnswers([
    e("action:still-going"), e("action:actually-done"),
    e("watch_detected"), e("session_30"), e("session_120"), e("test"),
  ], NOW);
  assertEquals([a.stillGoing, a.actuallyDone, a.total], [1, 1, 2]);
});

Deno.test("readAnswers excludes entries older than the window", () => {
  const a = readAnswers([e("action:still-going", 0), e("action:still-going", 9)], NOW);
  assertEquals(a.stillGoing, 1);
});

Deno.test("readAnswers attributes taps to the variant in body", () => {
  const a = readAnswers([e("action:still-going", 0, "classify"), e("action:pick:xyz", 0, "recall")], NOW);
  assertEquals(a.byVariant, { classify: 1, recall: 1 });
});

Deno.test("under 5 answers reports what is still needed and does not adapt", () => {
  const a = adapt(answers(2, 2, 0), "classify");
  assertEquals(a.nagScale, 1);
  assertEquals(a.variant, "classify");
  assert(a.reason.includes("1 more"), a.reason);
});

// THE REGRESSION THAT MATTERS. Measured on prod 2026-08-23: the last 7 days were 6 still-going vs
// 8 actually-done. A bucketed rule ("still-going >= 2x actually-done") returns exactly 1.0 here,
// i.e. the owner answers for a week and sees nothing change — the bug this module exists to fix.
Deno.test("the real prod distribution (6 vs 8) moves the number", () => {
  const a = adapt(answers(6, 8), "classify");
  assertEquals(a.nagScale, 0.91);
  assert(a.reason.includes("6") && a.reason.includes("8"), a.reason);
});

Deno.test("mostly still-going spreads nags out; mostly actually-done tightens them", () => {
  const up = adapt(answers(9, 1), "classify").nagScale;
  const down = adapt(answers(1, 9), "classify").nagScale;
  assert(up > 1 && up <= 1.6, `up=${up}`);
  assert(down < 1 && down >= 0.6, `down=${down}`);
});

Deno.test("flipping one answer toward still-going strictly increases the scale", () => {
  assert(adapt(answers(7, 7), "classify").nagScale > adapt(answers(6, 8), "classify").nagScale);
});

Deno.test("a variant that earns nothing rotates; one that earns taps does not", () => {
  const dead = adapt(readAnswers(Array.from({ length: 8 }, () => e("confirmed_5")), NOW), "classify");
  assertEquals(dead.variant, "recall");
  assert(VARIANTS.includes(dead.variant));
  assertEquals(adapt(answers(6, 8), "classify").variant, "classify");
});

Deno.test("adapt is deterministic for identical input", () => {
  assertEquals(adapt(answers(6, 8), "classify"), adapt(answers(6, 8), "classify"));
});

Deno.test("nagLadder rungs and cap", () => {
  assertEquals(nagLadder(29), []);
  assertEquals(nagLadder(95), [30, 60, 90]);
  assertEquals(nagLadder(115), [30, 60, 90, 110]);
  const full = nagLadder(300);
  // The invariant is BOUNDED, not a magic top rung: stepping 20 from 110 lands on 230, so 240 is
  // the ceiling no rung may cross, not a rung itself. A wedged session must stop nagging.
  assert(full[full.length - 1] <= 240, `last rung ${full[full.length - 1]} > 240`);
  assertEquals(nagLadder(10_000), full, "ladder must not grow past the cap");
  assert(full.every((v, i) => i === 0 || v > full[i - 1]), "strictly increasing");
});

Deno.test("scaling the ladder keeps it increasing and never tighter than scale 1", () => {
  const base = nagLadder(300), wide = nagLadder(300, 1.5);
  assert(wide.every((v, i) => i === 0 || v > wide[i - 1]), "strictly increasing");
  wide.forEach((v, i) => assert(v >= base[i], `rung ${i}: ${v} < ${base[i]}`));
});
