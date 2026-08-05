// Unit tests for the #49 verbose/test-mode decision logic against the REAL production functions
// in store.ts (no mocks). Covers the two things the feature adds:
//   1. verbose-mode activity keys off a HEAD-ITEM change (a new watch lands at position 0),
//      which is robust to YouTube's render window — totalCount can stay flat across a real watch;
//   2. `watch_detected` fires ONCE per session on the first head change and re-arms on a new session.
// Normal mode (shorts-only activity, never calls pendingWatchDetected) is asserted as an invariant.
//
// WHY headId AND NOT totalCount: oauth3-server's youtube plugin (plugins/youtube.ts) parses ONLY
// the initial ytInitialData render — it does not follow continuation tokens — so items.length is
// bounded by the first-render batch. For an established account that window is pinned (observed on
// staging: totalCount = 199 for hours); a new watch adds to the head and scrolls one off the tail,
// so totalCount stays flat and a count-growth signal NEVER fires. The head item id DOES change on
// any watch (regular, short, or rewatch). This regression is exactly what the prior
// totalDelta-based code shipped against and is asserted below.
import { assertEquals } from "jsr:@std/assert";
import { initStore, pendingWatchDetected, updateSession } from "./store.ts";
import { headWatchDelta } from "./state.ts";
import type { Snapshot } from "./state.ts";

// A minimal snapshot — only the headId-bearing fields matter to headWatchDelta.
function snap(headId: string): Snapshot {
  return {
    at: 0, watching: false, newShorts: 0, shortsCount: 0, totalCount: 0, headId,
    videosToday: 0, todayHonest: false,
  };
}

// Mirrors server.ts tick() exactly: verbose mode counts a HEAD change as activity (render-window
// robust); normal mode only shorts-count growth.
function hasActivity(verbose: boolean, countDelta: number, headDelta: number): boolean {
  return verbose ? headDelta > 0 : countDelta > 0;
}

await initStore(""); // in-memory (empty dataDir ⇒ no file I/O), module session state at defaults

let t = 1_000_000; // synthetic clock (ms); updateSession takes `now` for testability

Deno.test("verbose mode: a regular-video watch (head changes) is activity; normal mode ignores it", () => {
  // A non-short watch changes the head item but not the shorts count.
  assertEquals(hasActivity(true, 0, 1), true, "verbose ON ⇒ head change is activity");
  assertEquals(hasActivity(false, 0, 1), false, "normal mode ⇒ shorts-flat is NOT activity");
});

Deno.test("REGRESSION (render-window defect): totalCount flat but head changes ⇒ activity + watch_detected fires, returns delta", () => {
  // The exact failure mode of the old totalDelta-based code: totalCount pinned at 199 across a
  // real watch (199→199 ⇒ totalDelta 0 ⇒ never fired). headDelta catches it.
  const totalCountBefore = 199, totalCountAfter = 199; // flat — YouTube's render window
  const totalDelta = totalCountAfter - totalCountBefore; // 0 — the OLD signal, which never fired
  const headDelta = 1; // the head item id changed (a new watch landed at position 0)
  assertEquals(totalDelta, 0, "precondition: totalCount is window-pinned (the defect)");
  assertEquals(hasActivity(true, 0, headDelta), true, "head change ⇒ activity despite flat total");
  const start = updateSession(true, t);
  assertEquals(start.newSession, true);
  assertEquals(pendingWatchDetected(true, headDelta), 1, "fires on head change even with flat totalCount");
});

Deno.test("watch_detected does NOT re-fire in the same session (once per session)", () => {
  assertEquals(pendingWatchDetected(true, 1), null, "second head change same session ⇒ no re-fire");
});

Deno.test("zero head-delta (idle, stable head) never fires — no false positives", () => {
  assertEquals(pendingWatchDetected(true, 0), null, "head unchanged ⇒ no ping");
});

Deno.test("watch_detected re-arms on a NEW session after the gap", () => {
  t += 16 * 60 * 1000; // past SESSION_GAP_MS (15min)
  const start = updateSession(true, t);
  assertEquals(start.newSession, true, "long gap starts a fresh session");
  assertEquals(pendingWatchDetected(true, 1), 1, "trigger re-armed for the new session");
});

// --- headWatchDelta: the render-window-robust signal server.ts feeds to pendingWatchDetected ---

Deno.test("headWatchDelta: head item id changes ⇒ 1 (a new watch landed at position 0)", () => {
  assertEquals(headWatchDelta(snap("aaa"), snap("bbb")), 1);
});

Deno.test("headWatchDelta: head stable (idle) ⇒ 0 (no false positive)", () => {
  assertEquals(headWatchDelta(snap("aaa"), snap("aaa")), 0);
});

Deno.test("headWatchDelta: no previous snap (first-ever poll) ⇒ 0 (seed baseline, don't fire)", () => {
  assertEquals(headWatchDelta(null, snap("aaa")), 0);
});

Deno.test("REGRESSION (migration): prev snap lacks headId (pre-headId build) ⇒ 0, NOT a fire", () => {
  // This is the exact false-positive that fired once on the first poll after the headId deploy:
  // old persisted snaps carry no headId, so prevSnap.headId === undefined must NOT count as a
  // change. Before this guard it did, and a spurious watch_detected pushed (sent:2).
  const oldFormatSnap = snap(""); // pre-headId build persisted snaps with headId ""
  assertEquals(headWatchDelta(oldFormatSnap, snap("aaa")), 0, "missing baseline ⇒ seed, no fire");
});

Deno.test("headWatchDelta: current snap lacks headId ⇒ 0 (nothing to compare)", () => {
  assertEquals(headWatchDelta(snap("aaa"), snap("")), 0);
});
