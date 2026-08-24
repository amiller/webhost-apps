import type { ShortCheckResult } from "./oauth3-client.ts";

export type Vibe = "calm" | "positive" | "tired";
export type StateCode =
  | "night_owl" | "drained" | "hyped" | "chill" | "cozy" | "missing";

export interface Snapshot {
  at: number;
  watching: boolean;
  newShorts: number;
  shortsCount: number;
  /** Total items on the history page (shorts + regular). Logged only — NOT the watch signal
   *  (the youtube plugin's list is render-window-limited, so this stays flat for established
   *  accounts even after a new watch). `headId` is the robust signal. */
  totalCount: number;
  /** Topmost (most-recent) history item id. verbose/test-mode activity = a headId change. */
  headId: string;
  videosToday: number;
  /** True only when the youtube plugin surfaced per-item watched-at dates, so videosToday is
   *  genuinely today-scoped. False ⇒ videosToday is the whole page; UI must relabel "history". */
  todayHonest: boolean;
  /** Only the shorts first seen on THIS poll — notification copy quotes these, so feeding it the
   *  whole window would quote ancient videos. */
  shorts: { id: string; title: string; date?: string }[];
}

export interface PetState {
  energy: number;
  vibe: Vibe;
  stateCode: StateCode;
  continuousMinutes: number;
  shortsToday: number;
  computedAt: number;
}

// Verbose/test-mode watch signal: 1 iff the head item id changed vs the previous snap.
// SEEDS to 0 when there is no previous snap OR either snap lacks a head id — e.g. the first
// poll after a deploy, or a snap persisted by a pre-headId build (the migration case). Without
// this guard the first poll after deploy sees prevSnap.headId === undefined, treats that as a
// change, and fires a spurious "you watched something" off a missing baseline (observed live:
// one false watch_detected fired right after the headId deploy, sent:2, before this fix).
export function headWatchDelta(prev: Snapshot | null, cur: Snapshot): number {
  return cur.headId && prev?.headId && cur.headId !== prev.headId ? 1 : 0;
}

export function snapshotFrom(r: ShortCheckResult): Snapshot {
  return {
    at: Date.parse(r.checked) || Date.now(),
    watching: !!r.watching,
    newShorts: r.newShorts | 0,
    shortsCount: r.shortsCount | 0,
    totalCount: r.totalCount | 0,
    headId: r.headId ?? "",
    videosToday: r.videosToday | 0,
    todayHonest: !!r.todayHonest,
    shorts: r.shorts ?? [],
  };
}

// Longest run of consecutive watching:true snapshots whose gaps are < 15min.
function continuousMinutes(snaps: Snapshot[]): number {
  if (snaps.length === 0) return 0;
  const GAP = 15 * 60 * 1000;
  const sorted = [...snaps].sort((a, b) => a.at - b.at);
  let cur = 0, best = 0, prev: Snapshot | null = null;
  for (const s of sorted) {
    if (!s.watching) { best = Math.max(best, cur); cur = 0; prev = s; continue; }
    if (prev && prev.watching && (s.at - prev.at) < GAP) {
      cur += (s.at - prev.at);
    } else {
      cur = 0;
    }
    prev = s;
  }
  best = Math.max(best, cur);
  // If the last snap is recent & watching, prefer current streak
  const last = sorted[sorted.length - 1];
  if (last.watching && Date.now() - last.at < GAP) {
    return Math.round(cur / 60_000);
  }
  return Math.round(best / 60_000);
}

function sumNewShortsToday(snaps: Snapshot[]): number {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  return snaps
    .filter((s) => s.at >= startOfDay.getTime())
    .reduce((a, s) => a + s.newShorts, 0);
}

function pickVibe(continuous: number, shortsToday: number): Vibe {
  if (continuous >= 90) return "tired";
  if (shortsToday >= 30) return "positive";
  return "calm";
}

function pickStateCode(energy: number, vibe: Vibe, continuous: number, shortsToday: number): StateCode {
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 5 && continuous >= 30) return "night_owl";
  if (energy > 85 && vibe === "tired") return "drained";
  if (energy > 70 && vibe === "positive") return "hyped";
  if (energy > 70) return "cozy";
  if (energy >= 30) return "chill";
  if (shortsToday < 3 || energy < 10) return "missing";
  return "chill";
}

export function computeState(snaps: Snapshot[], prevEnergy: number): PetState {
  const now = Date.now();
  const continuous = continuousMinutes(snaps);
  const shortsToday = sumNewShortsToday(snaps);

  // Energy: +1 per ~2 new shorts seen today, blended with prev. Decay on idle.
  let energy = Math.min(100, shortsToday / 2);
  if (prevEnergy > 0) energy = Math.max(energy, prevEnergy);
  const last = snaps.length ? snaps[snaps.length - 1] : null;
  const idleMin = last ? (now - last.at) / 60_000 : 0;
  if (idleMin > 10) energy = Math.max(0, energy - (idleMin - 10) / 5);
  energy = Math.round(Math.min(100, Math.max(0, energy)));

  const vibe = pickVibe(continuous, shortsToday);
  const stateCode = pickStateCode(energy, vibe, continuous, shortsToday);

  return { energy, vibe, stateCode, continuousMinutes: continuous, shortsToday, computedAt: now };
}

export const pushCopy: Record<StateCode, string> = {
  night_owl: "It's late! Your cat is staying up with you 🌙 — maybe wind down?",
  drained: "You've been scrolling for a while. Your cat's getting tired, break time?",
  hyped: "So much cool stuff explored! Your cat is super hyped ✨",
  chill: "Casually scrolling — your cat is relaxed~",
  cozy: "Cozy vibes with your cat ~",
  missing: "Your cat misses you, come say hi!",
};

/**
 * Session-nag rungs: 30, 60, 90, then every 20 minutes, capped at 240 so a wedged session cannot
 * nag forever. `scale` comes from adapt() — >1 spreads them out, <1 tightens them. Returns only
 * the rungs at or below `sessionMin`, so pendingSessionMilestone fires each one exactly once.
 */
export function nagLadder(sessionMin: number, scale = 1): number[] {
  const base = [30, 60, 90];
  for (let m = 110; m <= 240; m += 20) base.push(m);
  const out: number[] = [];
  for (const b of base) {
    const r = Math.round(b * scale);
    if (r > sessionMin) break;
    if (!out.length || r > out[out.length - 1]) out.push(r);
  }
  return out;
}
