import type { PushLogEntry } from "./store.ts";

export interface Answers {
  stillGoing: number;
  actuallyDone: number;
  /** Taps keyed by the variant that produced them — `notif-action` stores it in `body`. */
  byVariant: Record<string, number>;
  /** confirmed_5 pushes sent in the window. Without this, a variant earning ZERO taps could
   *  never rotate: rotation keyed on taps alone deadlocks at total === 0. */
  confirmedSends: number;
  total: number;
}

export interface Adaptation {
  nagScale: number;
  variant: string;
  reason: string;
}

export const VARIANTS = ["classify", "recall", "mirror"];
const MIN_ANSWERS = 5;
const WINDOW_DAYS = 7;

export function readAnswers(log: PushLogEntry[], now: number, days = WINDOW_DAYS): Answers {
  const cutoff = now - days * 86_400_000;
  let stillGoing = 0, actuallyDone = 0, confirmedSends = 0;
  const byVariant: Record<string, number> = {};
  for (const e of log) {
    if (e.at < cutoff) continue;
    if (e.trigger === "confirmed_5") { confirmedSends++; continue; }
    if (!e.trigger.startsWith("action:")) continue;
    // Every tap counts toward its variant — including `pick:<id>` from the recall variant, which
    // is engagement even though it is neither still-going nor actually-done.
    if (e.body) byVariant[e.body] = (byVariant[e.body] ?? 0) + 1;
    const a = e.trigger.slice("action:".length);
    if (a === "still-going") stillGoing++;
    else if (a === "actually-done") actuallyDone++;
  }
  return { stillGoing, actuallyDone, byVariant, confirmedSends, total: stillGoing + actuallyDone };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Continuous, NOT bucketed. A threshold rule ("still-going >= 2x actually-done") returns exactly
 * 1.0 on the real distribution — measured 2026-08-23, the last 7 days were 6 still-going vs 8
 * actually-done — so the owner would answer for a week and see nothing change, which is the whole
 * complaint. Every answer has to move the number.
 */
export function adapt(a: Answers, current: string): Adaptation {
  if (a.total < MIN_ANSWERS) {
    // A variant that never earns a tap has to be able to rotate, and it cannot do that on tap
    // counts (it has none). Prompts-sent-with-nothing-back is the signal that works.
    if (a.confirmedSends >= MIN_ANSWERS && a.total === 0) {
      const next = VARIANTS[(VARIANTS.indexOf(current) + 1) % VARIANTS.length];
      return {
        nagScale: 1,
        variant: next,
        reason: `${a.confirmedSends} prompts in the last ${WINDOW_DAYS} days and no answers — switching from "${current}" to "${next}".`,
      };
    }
    const need = MIN_ANSWERS - a.total;
    return {
      nagScale: 1,
      variant: current,
      reason: `${a.total} answer${a.total === 1 ? "" : "s"} in the last ${WINDOW_DAYS} days — ${need} more and the cat starts adjusting.`,
    };
  }

  const nagScale = round2(clamp(1 + 0.6 * (a.stillGoing - a.actuallyDone) / a.total, 0.6, 1.6));
  const dir = nagScale > 1
    ? `nags are ${nagScale}x further apart`
    : nagScale < 1
    ? `nags are ${nagScale}x closer together`
    : "nag spacing is unchanged";
  return {
    nagScale,
    variant: current,
    reason: `Last ${WINDOW_DAYS} days: ${a.stillGoing} "still going", ${a.actuallyDone} "actually done" — ${dir}.`,
  };
}
