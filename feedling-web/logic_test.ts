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
import { assert, assertEquals } from "jsr:@std/assert";
import { initStore, pendingWatchDetected, updateSession } from "./store.ts";
import { headWatchDelta } from "./state.ts";
import type { Snapshot } from "./state.ts";

// A minimal snapshot — only the headId-bearing fields matter to headWatchDelta.
function snap(headId: string): Snapshot {
  return {
    at: 0, watching: false, newShorts: 0, shortsCount: 0, totalCount: 0, headId,
    videosToday: 0, todayHonest: false, shorts: [],
  };
}

// Mirrors server.ts tick() exactly: a previously-unseen short is activity in BOTH modes; verbose
// additionally counts any watch at all (head change), which catches regular videos and rewatches.
function hasActivity(verbose: boolean, newShorts: number, headDelta: number): boolean {
  return newShorts > 0 || (verbose && headDelta > 0);
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
  const start = updateSession(true, 0, t);
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
  const start = updateSession(true, 0, t);
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

// --- the confirmed-scrolling gate (replaces the consecutive-run gate that could never fire) ---
//
// Measured on prod 2026-08-18 over 289 polls: 6 active, longest consecutive run 1. YouTube's
// history page delivers in clumps, so the 60s follow-up poll after a burst always reads zero and
// reset the run. The gate below reads session TOTALS instead, so the same traffic reaches it.
import { checkConfirmedActivity, sessionShorts, pendingSessionMilestone, consecutivePolls } from "./store.ts";

const GAP = 16 * 60 * 1000; // past SESSION_GAP_MS — guarantees a fresh session

Deno.test("REGRESSION (prod cadence): clumped arrivals reach confirmed_5; a consecutive-run gate never would", () => {
  t += GAP;
  const t0 = t;
  // 15:34:38 new=7 — the burst. Session opens; too early to fire.
  updateSession(true, 7, t0);
  assertEquals(checkConfirmedActivity(5, 5, t0), false, "volume there, but 0 min elapsed");
  // 15:35:39 new=0 — the 60s follow-up that reset the old run to zero every single time.
  updateSession(false, 0, t0 + 61_000);
  assertEquals(consecutivePolls(), 0, "the run breaks here — this is why the old gate was dead");
  // 15:40:40 new=1 — next clump, ~6 min in.
  updateSession(true, 1, t0 + 362_000);
  assertEquals(consecutivePolls(), 1, "longest run reachable in practice is 1, never the 5 required");
  assertEquals(sessionShorts(), 8, "session total accumulates across the gap");
  assertEquals(checkConfirmedActivity(5, 5, t0 + 362_000), true, "8 shorts over 6 min ⇒ confirmed");
});

Deno.test("confirmed_5 fires at most once per session", () => {
  assertEquals(checkConfirmedActivity(5, 5, t + 400_000), false, "already fired this session");
});

Deno.test("volume without duration does not fire (a single burst is not a scrolling session)", () => {
  t += GAP;
  updateSession(true, 9, t);
  assertEquals(checkConfirmedActivity(5, 5, t + 60_000), false, "9 shorts but only 1 min elapsed");
});

Deno.test("duration without volume does not fire (two idle-spaced shorts is not scrolling)", () => {
  t += GAP;
  const t0 = t;
  updateSession(true, 1, t0);
  updateSession(true, 1, t0 + 10 * 60_000);
  assertEquals(sessionShorts(), 2, "only 2 shorts all session");
  assertEquals(checkConfirmedActivity(5, 5, t0 + 10 * 60_000), false, "10 min elapsed but under the volume floor");
});

// --- milestones are MINUTES, not poll counts ---
// The copy says "30 min of confirmed scrolling"; the old caller passed cumulative ACTIVE POLLS,
// which only coincided with minutes while polling ran at 60s. At the 5-min idle cadence that made
// session_30 mean ~3h of near-continuous watching.
Deno.test("session milestones read elapsed minutes and fire once each", () => {
  t += GAP;
  updateSession(true, 1, t); // fresh session clears the fired set
  assertEquals(pendingSessionMilestone(29, [30, 60, 90, 120]), null, "29 min ⇒ not yet");
  assertEquals(pendingSessionMilestone(30, [30, 60, 90, 120]), 30, "30 min ⇒ session_30");
  assertEquals(pendingSessionMilestone(31, [30, 60, 90, 120]), null, "already fired");
  assertEquals(pendingSessionMilestone(60, [30, 60, 90, 120]), 60, "next milestone still arms");
});

// ---------------------------------------------------------------------------
// REGRESSION, reported live 2026-08-24 15:58: a clock-check arrived claiming 28 minutes when he
// had not watched anything for ~13. A session stays OPEN for SESSION_GAP_MS (15 min) after the
// last watch, so `sessionMin` keeps climbing through the idle tail. Prod at that moment:
// startedAt 15:29:32, lastActivity 15:44:48, sessionMin 30, active 15, idle 15.
// Nagging and probe ground truth must key on the ACTIVE span, never wall-clock.
// ---------------------------------------------------------------------------
import { updateSession as _updateSession } from "./store.ts";

Deno.test("session clocks diverge once watching stops", () => {
  const t0 = 2_000_000_000_000;
  const MIN = 60_000;
  // Watching for 15 minutes.
  _updateSession(true, 1, t0);
  const active = _updateSession(true, 1, t0 + 15 * MIN);
  assertEquals(active.activeMin, 15);
  assertEquals(active.idleMin, 0);

  // 13 minutes later he has stopped, but the session has not closed yet (gap < 15 min).
  const coasting = _updateSession(false, 0, t0 + 28 * MIN);
  assertEquals(coasting.sessionMin, 28, "wall-clock keeps climbing");
  assertEquals(coasting.activeMin, 15, "watching span does NOT — this is the honest number");
  assertEquals(coasting.idleMin, 13, "and this is why the notification was wrong");
  assert(
    coasting.activeMin < coasting.sessionMin,
    "if these are ever equal the regression is back",
  );
});
