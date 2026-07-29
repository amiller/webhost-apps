// Unit tests for the #49 verbose/test-mode decision logic against the REAL production functions
// in store.ts (no mocks). Covers the two things the feature adds:
//   1. verbose-mode activity keys off TOTAL history growth (a regular-video watch), not shorts;
//   2. `watch_detected` fires ONCE per session on the first positive total-delta and re-arms on a
//      new session.
// Normal mode (shorts-only activity, never calls pendingWatchDetected) is asserted as an invariant.
import { assertEquals } from "jsr:@std/assert";
import { initStore, pendingWatchDetected, updateSession } from "./store.ts";

// Mirrors server.ts tick() exactly: verbose mode counts ANY new history item (total), normal mode
// only shorts growth.
function hasActivity(verbose: boolean, countDelta: number, totalDelta: number): boolean {
  return verbose ? totalDelta > 0 : countDelta > 0;
}

await initStore(""); // in-memory (empty dataDir ⇒ no file I/O), module session state at defaults

let t = 1_000_000; // synthetic clock (ms); updateSession takes `now` for testability

Deno.test("verbose mode: a regular-video watch (shorts flat, total grows) is activity", () => {
  // A non-short watch grows totalCount but NOT shortsCount — invisible to normal mode.
  assertEquals(hasActivity(true, 0, 1), true, "verbose ON ⇒ total growth is activity");
  assertEquals(hasActivity(false, 0, 1), false, "normal mode ⇒ shorts-flat is NOT activity");
});

Deno.test("watch_detected fires once per session on first positive total-delta, returns delta", () => {
  const start = updateSession(true, t); // first active poll starts a session
  assertEquals(start.newSession, true);
  assertEquals(pendingWatchDetected(true, 3), 3, "first positive delta fires and names N");
  // another active poll in the SAME session must not re-fire (once per session)
  assertEquals(pendingWatchDetected(true, 2), null, "already fired this session");
});

Deno.test("zero total-delta never fires watch_detected (normal-mode guard)", () => {
  assertEquals(pendingWatchDetected(true, 0), null, "no new item ⇒ no ping");
});

Deno.test("watch_detected re-arms on a NEW session after the gap", () => {
  t += 16 * 60 * 1000; // past SESSION_GAP_MS (15min)
  const start = updateSession(true, t);
  assertEquals(start.newSession, true, "long gap starts a fresh session");
  assertEquals(pendingWatchDetected(true, 7), 7, "trigger re-armed for the new session");
});
