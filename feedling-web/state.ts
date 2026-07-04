import type { ShortCheckResult } from "./oauth3-client.ts";

export type Vibe = "calm" | "positive" | "tired";
export type StateCode =
  | "night_owl" | "drained" | "hyped" | "chill" | "cozy" | "missing";

export interface Snapshot {
  at: number;
  watching: boolean;
  newShorts: number;
  shortsCount: number;
  videosToday: number;
}

export interface PetState {
  energy: number;
  vibe: Vibe;
  stateCode: StateCode;
  continuousMinutes: number;
  shortsToday: number;
  computedAt: number;
}

export function snapshotFrom(r: ShortCheckResult): Snapshot {
  return {
    at: Date.parse(r.checked) || Date.now(),
    watching: !!r.watching,
    newShorts: r.newShorts | 0,
    shortsCount: r.shortsCount | 0,
    videosToday: r.videosToday | 0,
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
