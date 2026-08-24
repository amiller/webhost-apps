import type { PushLogEntry } from "./store.ts";

export interface Answers {
  /** Answers meaning "I'll keep going": yes-more, not-stopping (+ legacy still-going). */
  stillGoing: number;
  /** Answers meaning "I'm stopping": no-done, done-hold-me (+ legacy actually-done). */
  actuallyDone: number;
  /** Taps keyed by the variant that produced them — `notif-action` stores it in `body`. */
  byVariant: Record<string, number>;
  /** Every tap, whatever it said. */
  answered: number;
  /** Only the taps that bear on nag spacing (continue vs stop). */
  directional: number;
  /** confirmed_5 pushes sent in the window. Without this, a variant earning ZERO taps could
   *  never rotate: rotation keyed on taps alone deadlocks at total === 0. */
  confirmedSends: number;
  total: number;
}

export interface Adaptation {
  nagScale: number;
  reason: string;
}

// The predict/commit arms are randomised PER SEND in server.ts, not rotated per day. Daily
// rotation was both wrong for a within-subject contrast (it confounds arm with date) and buggy:
// `total` excluded `pick:*` taps, so a variant that WAS being answered still read total === 0 and
// tripped the "no answers — switching" rule, i.e. it got rotated away from for being answered.
export const ARMS = ["predict", "commit"];
const MIN_ANSWERS = 5;
const WINDOW_DAYS = 7;

export function readAnswers(log: PushLogEntry[], now: number, days = WINDOW_DAYS): Answers {
  const cutoff = now - days * 86_400_000;
  let stillGoing = 0, actuallyDone = 0, confirmedSends = 0, answered = 0;
  const byVariant: Record<string, number> = {};
  for (const e of log) {
    if (e.at < cutoff) continue;
    if (e.trigger === "confirmed_5") { confirmedSends++; continue; }
    if (!e.trigger.startsWith("action:")) continue;
    // Every tap counts toward its variant — including `pick:<id>` from the recall variant, which
    // is engagement even though it is neither still-going nor actually-done.
    if (e.body) byVariant[e.body] = (byVariant[e.body] ?? 0) + 1;
    const a = e.trigger.slice("action:".length);
    answered++;
    if (a === "still-going" || a === "yes-more" || a === "not-stopping") stillGoing++;
    else if (a === "actually-done" || a === "no-done" || a === "done-hold-me") actuallyDone++;
    // `min:*` timecheck taps count as answered but carry no continue/stop meaning.
  }
  // `total` is EVERY answer, so no probe type is invisible to the "is this being answered" test.
  // `directional` is only the answers that actually bear on nag spacing.
  return { stillGoing, actuallyDone, byVariant, confirmedSends, answered, total: answered,
           directional: stillGoing + actuallyDone };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Continuous, NOT bucketed. A threshold rule ("still-going >= 2x actually-done") returns exactly
 * 1.0 on the real distribution — measured 2026-08-23, the last 7 days were 6 still-going vs 8
 * actually-done — so the owner would answer for a week and see nothing change, which is the whole
 * complaint. Every answer has to move the number.
 */
export function adapt(a: Answers): Adaptation {
  if (a.directional < MIN_ANSWERS) {
    const need = MIN_ANSWERS - a.directional;
    return {
      nagScale: 1,
      reason: `${a.directional} directional answer${a.directional === 1 ? "" : "s"} in the last ${WINDOW_DAYS} days — ${need} more and the cat starts adjusting.`,
    };
  }

  const nagScale = round2(clamp(1 + 0.6 * (a.stillGoing - a.actuallyDone) / a.directional, 0.6, 1.6));
  const dir = nagScale > 1
    ? `nags are ${nagScale}x further apart`
    : nagScale < 1
    ? `nags are ${nagScale}x closer together`
    : "nag spacing is unchanged";
  return {
    nagScale,
    reason: `Last ${WINDOW_DAYS} days: ${a.stillGoing} "keep going", ${a.actuallyDone} "stopping" — ${dir}.`,
  };
}
