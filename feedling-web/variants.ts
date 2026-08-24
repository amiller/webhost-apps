import type { Snapshot } from "./state.ts";
import type { PushExtra } from "./push.ts";

export type Notif = { title: string; body: string; url: string; extra: PushExtra };

function seen(snaps: Snapshot[]): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  const ids = new Set<string>();
  for (const s of snaps) {
    for (const v of s.shorts ?? []) {
      if (v.id && v.title && !ids.has(v.id)) { ids.add(v.id); out.push(v); }
    }
  }
  return out;
}

/**
 * Build the confirmed_5 notification for a variant.
 * Returns null when the variant has nothing honest to say — the caller skips the push.
 */
export function streakNotif(variant: string, snaps: Snapshot[]): Notif | null {
  const history = seen(snaps);

  // The two arms of the predict/commit split. "Which one is this?" collapsed three different
  // questions — report ("what were you doing"), predict ("will you continue"), decide ("are you
  // stopping") — into one string, so an answer had no stable referent and the adaptation built on
  // it meant nothing. Each arm now asks exactly one of them, and BOTH are scored the same way:
  // the tick loop keeps watching for HORIZON_MS afterwards, so the answer is checked against
  // behaviour rather than trusted. The contrast between arms is the actual experiment — does
  // committing to stop produce more stopping than merely predicting it?
  if (variant === "predict") {
    return {
      title: "Prediction.",
      body: "Will you still be scrolling in 5 minutes?",
      url: "",
      extra: {
        variant,
        actions: [
          { action: "yes-more", title: "Yes, more" },
          { action: "no-done", title: "No, done soon" },
        ],
      },
    };
  }

  if (variant === "commit") {
    return {
      title: "Decision.",
      body: "Done after this one?",
      url: "",
      extra: {
        variant,
        actions: [
          { action: "done-hold-me", title: "Done \u2014 hold me to it" },
          { action: "not-stopping", title: "Not stopping yet" },
        ],
      },
    };
  }

  if (variant === "recall") {
    // Need a target from a few videos back plus a distractor from real history.
    if (history.length < 4) return null;
    const target = history[history.length - 4];
    const distractor = history[0];
    if (target.id === distractor.id) return null;
    // Order by id so the correct answer isn't always in the same slot.
    const [a, b] = target.id < distractor.id ? [target, distractor] : [distractor, target];
    return {
      title: "Four videos ago.",
      body: "What was this one about?",
      url: "",
      extra: {
        variant,
        image: `https://i.ytimg.com/vi/${target.id}/hqdefault.jpg`,
        actions: [
          { action: `pick:${a.id}`, title: a.title.slice(0, 28) },
          { action: `pick:${b.id}`, title: b.title.slice(0, 28) },
        ],
      },
    };
  }

  if (variant === "mirror") {
    const last = history.slice(-6);
    if (last.length < 3) return null;
    return {
      title: `The last ${last.length}.`,
      body: last.map((v) => v.title).join("\n"),
      url: "",
      extra: { variant },
    };
  }


  throw new Error(`unknown STREAK_VARIANT: ${variant}`);
}

/**
 * Time-perception probe for the session-milestone slots, which until now carried NO buttons at all
 * (`extra` stayed `{}` for every `session_*` push) — so their zero taps measured nothing. They are
 * the only free question budget the channel has.
 *
 * Underestimating elapsed time is the signature of absorbed scrolling, and unlike a preference
 * question this one has an exact answer the app already holds. The truth moves every session, so it
 * cannot decay into a reflex the way a fixed binary does.
 */
export function timeCheckNotif(trueMin: number): Notif & { truth: { trueMin: number; decoyMin: number } } {
  const decoy = Math.random() < 0.5 ? Math.max(5, Math.round(trueMin / 2)) : trueMin * 2;
  const [lo, hi] = trueMin < decoy ? [trueMin, decoy] : [decoy, trueMin];
  return {
    title: "Clock check.",
    body: "How long has this session been?",
    url: "",
    truth: { trueMin, decoyMin: decoy },
    extra: {
      variant: "timecheck",
      actions: [
        { action: `min:${lo}`, title: `About ${lo} min` },
        { action: `min:${hi}`, title: `About ${hi} min` },
      ],
    },
  };
}
