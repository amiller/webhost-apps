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

  if (variant === "classify") {
    return {
      title: "Five minutes in.",
      body: "Which one is this?",
      url: "",
      extra: {
        variant,
        actions: [
          { action: "still-going", title: "Still going" },
          { action: "actually-done", title: "Actually done" },
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
