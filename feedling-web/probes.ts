/**
 * The experiment ledger.
 *
 * A probe is a question sent with the notification, plus everything needed to score it LATER
 * without trusting self-report: the arm it belongs to, the ground truth at send time, the answer
 * if one comes, and the behavioural outcome observed afterwards.
 *
 * Deliberately NOT the push log: that is a 500-entry ring buffer (~28 days at 17 pushes/day), and
 * an experiment needs its rows to survive longer than the experiment. Append-only JSONL, no TTL.
 */
export type ProbeKind = "predict" | "commit" | "timecheck";

export interface Probe {
  id: string;
  kind: ProbeKind;
  at: number;
  /** Ground truth captured at SEND time — scoring must not re-derive it later. */
  truth?: Record<string, unknown>;
  /** Button actions in the order shown, so a tap can be interpreted after the fact. */
  options: string[];
  answer?: string;
  answeredAt?: number;
  /** Did watching continue in the horizon after the probe? Observed, never asked. */
  outcome?: "continued" | "stopped";
  scoredAt?: number;
}

export const HORIZON_MS = 5 * 60 * 1000;

let file = "";
const probes: Probe[] = [];
const byId = new Map<string, Probe>();

export async function initProbes(dataDir: string): Promise<void> {
  if (!dataDir) return;
  file = `${dataDir}/probes.jsonl`;
  try {
    for (const line of (await Deno.readTextFile(file)).split("\n")) {
      if (!line.trim()) continue;
      const p = JSON.parse(line) as Probe;
      byId.set(p.id, p);
    }
    probes.push(...byId.values());
    probes.sort((a, b) => a.at - b.at);
    console.log(`[probes] loaded ${probes.length}`);
  } catch { /* none yet */ }
}

// Rewritten whole rather than appended: a probe row MUTATES twice after it is written (answer,
// then outcome), so append-only lines would leave stale duplicates for a reader to reconcile.
async function persist(): Promise<void> {
  if (!file) return;
  await Deno.writeTextFile(file, probes.map((p) => JSON.stringify(p)).join("\n") + "\n");
}

export async function openProbe(
  kind: ProbeKind, options: string[], truth?: Record<string, unknown>, now = Date.now(),
): Promise<Probe> {
  const p: Probe = { id: `${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, kind, at: now, truth, options };
  probes.push(p);
  byId.set(p.id, p);
  await persist();
  return p;
}

/** Correlate a tap to its probe by nonce. Adjacency in the push log is NOT a correlation. */
export async function answerProbe(id: string, answer: string, at = Date.now()): Promise<boolean> {
  const p = byId.get(id);
  if (!p || p.answer) return false;
  p.answer = answer;
  p.answeredAt = at;
  await persist();
  return true;
}

/**
 * Score every probe whose horizon has elapsed. `activityInWindow` answers "was anything watched
 * between these two times" from the corpus — an observation, so an unanswered probe still scores.
 */
export async function scoreDue(
  activityInWindow: (from: number, to: number) => boolean, now = Date.now(),
): Promise<number> {
  const due = probes.filter((p) => !p.scoredAt && now >= p.at + HORIZON_MS);
  for (const p of due) {
    p.outcome = activityInWindow(p.at, p.at + HORIZON_MS) ? "continued" : "stopped";
    p.scoredAt = now;
  }
  if (due.length) await persist();
  return due.length;
}

export function getProbes(since = 0): Probe[] {
  return since ? probes.filter((p) => p.at >= since) : probes.slice();
}

/** Answer rate is the kill signal for a redesign: a probe too costly to answer gets swatted. */
export function probeStats(since = 0): Record<string, unknown> {
  const rows = getProbes(since);
  const by = (k: ProbeKind) => rows.filter((r) => r.kind === k);
  const rate = (rs: Probe[]) => rs.length ? +(rs.filter((r) => r.answer).length / rs.length).toFixed(2) : null;
  const stopped = (rs: Probe[]) => {
    const s = rs.filter((r) => r.outcome);
    return s.length ? +(s.filter((r) => r.outcome === "stopped").length / s.length).toFixed(2) : null;
  };
  const out: Record<string, unknown> = { total: rows.length, answered: rows.filter((r) => r.answer).length };
  for (const k of ["predict", "commit", "timecheck"] as ProbeKind[]) {
    out[k] = { sent: by(k).length, answerRate: rate(by(k)), stopRate: stopped(by(k)) };
  }
  return out;
}
