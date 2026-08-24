import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { openProbe, answerProbe, scoreDue, getProbes, probeStats, HORIZON_MS } from "./probes.ts";
import { timeCheckNotif } from "./variants.ts";

// initProbes() is never called, so file is "" and nothing touches disk.
const T0 = 1_800_000_000_000;

Deno.test("a probe records the arm, the options and the ground truth at SEND time", async () => {
  const p = await openProbe("timecheck", ["min:15", "min:30"], { trueMin: 30, decoyMin: 15 }, T0);
  assertEquals(p.kind, "timecheck");
  assertEquals(p.options, ["min:15", "min:30"]);
  assertEquals((p.truth as { trueMin: number }).trueMin, 30);
  assert(p.id.length > 0);
});

Deno.test("answers correlate by nonce, and a second answer cannot overwrite the first", async () => {
  const p = await openProbe("predict", ["yes-more", "no-done"], undefined, T0);
  assertEquals(await answerProbe(p.id, "no-done", T0 + 19_000), true);
  assertEquals(await answerProbe(p.id, "yes-more", T0 + 60_000), false, "already answered");
  const got = getProbes().find((x) => x.id === p.id)!;
  assertEquals(got.answer, "no-done");
  assertEquals(got.answeredAt, T0 + 19_000, "the real tap time is kept, not the receive time");
});

Deno.test("an unknown nonce does not match anything", async () => {
  assertEquals(await answerProbe("nope", "yes-more", T0), false);
});

Deno.test("scoring is behavioural: an UNANSWERED probe still gets an outcome", async () => {
  const p = await openProbe("commit", ["done-hold-me", "not-stopping"], undefined, T0);
  // Nothing watched in the horizon.
  await scoreDue(() => false, T0 + HORIZON_MS);
  const got = getProbes().find((x) => x.id === p.id)!;
  assertEquals(got.answer, undefined, "never answered");
  assertEquals(got.outcome, "stopped", "outcome comes from observation, not from the tap");
});

Deno.test("watching inside the horizon scores as continued", async () => {
  const p = await openProbe("predict", ["yes-more", "no-done"], undefined, T0 + 10_000_000);
  await scoreDue((from, to) => from < to, T0 + 10_000_000 + HORIZON_MS);
  assertEquals(getProbes().find((x) => x.id === p.id)!.outcome, "continued");
});

Deno.test("a probe inside its horizon is not scored yet", async () => {
  const p = await openProbe("predict", ["yes-more", "no-done"], undefined, T0 + 20_000_000);
  const n = await scoreDue(() => true, T0 + 20_000_000 + HORIZON_MS - 1);
  assertEquals(n, 0);
  assertEquals(getProbes().find((x) => x.id === p.id)!.outcome, undefined);
});

Deno.test("scoring is idempotent — a scored probe is not rescored", async () => {
  const first = await scoreDue(() => true, T0 + 99_000_000);
  const second = await scoreDue(() => true, T0 + 99_000_000);
  assert(first >= 0);
  assertEquals(second, 0);
});

Deno.test("stats expose the answer rate, which is the kill signal", () => {
  const s = probeStats() as Record<string, { sent: number; answerRate: number | null }>;
  assert((s.predict as { sent: number }).sent > 0);
  assert("answerRate" in s.predict);
});

Deno.test("timecheck offers the true elapsed time against a decoy, ordered low-high", () => {
  for (let i = 0; i < 40; i++) {
    const n = timeCheckNotif(30);
    const opts = n.extra.actions!.map((a) => Number(a.action.split(":")[1]));
    assertEquals(opts[0] < opts[1], true, "ascending, so the true answer is not always one side");
    assert(opts.includes(30), "the true elapsed time is always one of the options");
    assertEquals(n.truth.trueMin, 30);
    assert(n.truth.decoyMin === 15 || n.truth.decoyMin === 60, `decoy was ${n.truth.decoyMin}`);
  }
});
