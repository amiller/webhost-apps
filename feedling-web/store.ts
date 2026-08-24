import type { Snapshot, PetState } from "./state.ts";

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: number;
}

const MAX_SNAPS = 24 * 60 / 5 + 10;

const snaps: Snapshot[] = [];
let lastState: PetState | null = null;
let lastPushedState: string | null = null;
const sessionMilestoneFired: Set<number> = new Set();
let sessionStartedAt: number | null = null;
let lastActivityAt: number | null = null;
let consecutiveActivePolls = 0;
let cumulativeActivePolls = 0;
let confirmedActivityFired = false;
let sessionNewShorts = 0;
let watchDetectedFired = false;

let dataDir = "";
let subsFile = "";
let snapsFile = "";
let pushLogFile = "";
const subs: Map<string, PushSub> = new Map();

const SNAP_TTL_MS = 24 * 60 * 60 * 1000;
const PUSH_LOG_MAX = 500;

export interface PushLogEntry {
  at: number;
  trigger: string;
  body: string;
  sent: number;
  pruned: number;
  endpoints: { host: string; ok: boolean; status?: number; error?: string }[];
  /** Which probe this push carried, if any. Without it a `pick:`/`min:` tap is uninterpretable —
   *  you know an answer arrived but not what was asked or which option was correct. */
  probeId?: string;
  probeKind?: string;
}
const pushLog: PushLogEntry[] = [];

// The corpus ledger: an APPEND-ONLY record of every history item ever seen, with the time it was
// first observed. This is the only durable record of what was watched — snapshots expire after 24h
// and YouTube's history page carries no per-item dates, so anything not written here is gone.
// Measured 2026-08-24: the ~200-item window turned over 117 items in 13h, i.e. ~200/day were
// being discarded. NO TTL: a year of watching is ~5MB.
export interface CorpusEntry {
  id: string;
  title: string;
  isShort: boolean;
  /** When feedling FIRST SAW it, not when YouTube says it was watched (it says nothing).
   *  Polling is 60s in verbose mode, so this trails the real watch by minutes at most. */
  firstSeen: number;
}
let corpusFile = "";
const corpus: CorpusEntry[] = [];
const corpusIds = new Set<string>();

export async function initStore(dir: string): Promise<void> {
  dataDir = dir;
  if (!dataDir) return;
  subsFile = `${dataDir}/subs.json`;
  snapsFile = `${dataDir}/snaps.json`;
  pushLogFile = `${dataDir}/pushes.json`;
  corpusFile = `${dataDir}/corpus.jsonl`;
  try {
    const txt = await Deno.readTextFile(corpusFile);
    for (const line of txt.split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as CorpusEntry;
      if (!corpusIds.has(e.id)) { corpusIds.add(e.id); corpus.push(e); }
    }
    console.log(`[store] loaded ${corpus.length} corpus entries`);
  } catch { /* no corpus yet */ }
  try {
    const txt = await Deno.readTextFile(subsFile);
    const arr = JSON.parse(txt) as PushSub[];
    for (const s of arr) subs.set(s.endpoint, s);
    console.log(`[store] loaded ${subs.size} subs from ${subsFile}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) console.error("[store] subs load:", (e as Error).message);
  }
  try {
    const txt = await Deno.readTextFile(snapsFile);
    const arr = JSON.parse(txt) as Snapshot[];
    const cutoff = Date.now() - SNAP_TTL_MS;
    for (const s of arr) if (s.at >= cutoff) snaps.push(s);
    console.log(`[store] loaded ${snaps.length} snaps (filtered to last 24h)`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) console.error("[store] snaps load:", (e as Error).message);
  }
  try {
    const txt = await Deno.readTextFile(pushLogFile);
    const arr = JSON.parse(txt) as PushLogEntry[];
    pushLog.push(...arr);
    console.log(`[store] loaded ${pushLog.length} push log entries`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) console.error("[store] pushlog load:", (e as Error).message);
  }
}

async function persistSnaps(): Promise<void> {
  if (!snapsFile) return;
  await Deno.writeTextFile(snapsFile, JSON.stringify(snaps));
}

async function persistPushLog(): Promise<void> {
  if (!pushLogFile) return;
  await Deno.writeTextFile(pushLogFile, JSON.stringify(pushLog));
}

async function persistSubs(): Promise<void> {
  if (!subsFile) return;
  await Deno.writeTextFile(subsFile, JSON.stringify(Array.from(subs.values()), null, 2));
}

export async function addSnapshot(s: Snapshot): Promise<void> {
  snaps.push(s);
  const cutoff = Date.now() - SNAP_TTL_MS;
  while (snaps.length && snaps[0].at < cutoff) snaps.shift();
  if (snaps.length > MAX_SNAPS) snaps.splice(0, snaps.length - MAX_SNAPS);
  await persistSnaps();
}

export async function recordPush(entry: PushLogEntry): Promise<void> {
  pushLog.push(entry);
  if (pushLog.length > PUSH_LOG_MAX) pushLog.splice(0, pushLog.length - PUSH_LOG_MAX);
  await persistPushLog();
}

export function getPushLog(limit?: number): PushLogEntry[] {
  if (!limit || limit >= pushLog.length) return pushLog.slice();
  return pushLog.slice(-limit);
}

export function recentSnapshots(): Snapshot[] {
  return snaps.slice();
}

export function setState(s: PetState) { lastState = s; }
export function getState(): PetState | null { return lastState; }

export function markPushed(code: string) { lastPushedState = code; }
export function lastPushed(): string | null { return lastPushedState; }

// Session: contiguous activity, broken by SESSION_GAP_MS of no activity.
const SESSION_GAP_MS = 15 * 60 * 1000;

export interface SessionUpdate {
  newSession: boolean;
  sessionMin: number; // 0 if no session
  startedAt: number | null;
}

// Call once per tick. `hasActivity` is true iff this poll saw a previously-unseen short (or, in
// verbose mode, any new watch); `newShorts` is how many, accumulated across the session so the
// confirmed-scrolling gate can read a total instead of a run of consecutive polls.
export function updateSession(hasActivity: boolean, newShorts = 0, now = Date.now()): SessionUpdate {
  if (hasActivity) {
    let newSession = false;
    if (sessionStartedAt === null || (lastActivityAt !== null && now - lastActivityAt > SESSION_GAP_MS)) {
      sessionStartedAt = now;
      sessionMilestoneFired.clear();
      consecutiveActivePolls = 0;
      cumulativeActivePolls = 0;
      confirmedActivityFired = false;
      watchDetectedFired = false;
      sessionNewShorts = 0;
      newSession = true;
    }
    cumulativeActivePolls += 1;
    consecutiveActivePolls += 1;
    sessionNewShorts += newShorts;
    lastActivityAt = now;
    return { newSession, sessionMin: Math.round((now - sessionStartedAt) / 60_000), startedAt: sessionStartedAt };
  }
  consecutiveActivePolls = 0;
  // No activity: optionally close out a stale session
  if (sessionStartedAt !== null && lastActivityAt !== null && now - lastActivityAt > SESSION_GAP_MS) {
    sessionStartedAt = null;
  }
  return {
    newSession: false,
    sessionMin: sessionStartedAt ? Math.round((now - sessionStartedAt) / 60_000) : 0,
    startedAt: sessionStartedAt,
  };
}

// "Confirmed scrolling": once per session, when the session has both accumulated enough new
// shorts AND lasted long enough. The old gate wanted N CONSECUTIVE active polls, which the real
// signal can never deliver: YouTube's history page updates in clumps, so the 60s follow-up poll
// after a burst always reads zero and reset the run. Measured on prod 2026-08-18 — 289 polls,
// 6 of them active, longest consecutive run 1. This gate is reachable by the same traffic.
export function checkConfirmedActivity(minShorts = 5, minMinutes = 5, now = Date.now()): boolean {
  if (confirmedActivityFired || sessionStartedAt === null) return false;
  if (sessionNewShorts < minShorts || now - sessionStartedAt < minMinutes * 60_000) return false;
  confirmedActivityFired = true;
  return true;
}

export function sessionShorts(): number { return sessionNewShorts; }

export function consecutivePolls(): number { return consecutiveActivePolls; }
export function cumulativePolls(): number { return cumulativeActivePolls; }

// Verbose/test-mode trigger: fires once per session on the FIRST poll that sees a positive
// count delta (i.e. a new watch), returning the delta so the push can name "N new item(s)".
// Armed again on every new session (see updateSession). Normal mode never calls this.
export function pendingWatchDetected(hasActivity: boolean, delta: number): number | null {
  if (hasActivity && delta > 0 && !watchDetectedFired) {
    watchDetectedFired = true;
    return delta;
  }
  return null;
}

// Returns the largest milestone just crossed within the current session. Callers pass ELAPSED
// SESSION MINUTES — the copy ("30 min of confirmed scrolling") claims minutes, and the old caller
// passed active-poll counts, which only coincided while polling ran at 60s.
export function pendingSessionMilestone(sessionMin: number, milestones: number[]): number | null {
  let crossed: number | null = null;
  for (const m of milestones) {
    if (sessionMin >= m && !sessionMilestoneFired.has(m)) {
      crossed = m;
      sessionMilestoneFired.add(m);
    }
  }
  return crossed;
}

export function getSession(): { startedAt: number | null; lastActivityAt: number | null } {
  return { startedAt: sessionStartedAt, lastActivityAt };
}

export async function addSub(s: Omit<PushSub, "createdAt">): Promise<void> {
  subs.set(s.endpoint, { ...s, createdAt: Date.now() });
  await persistSubs();
}

export async function removeSub(endpoint: string): Promise<void> {
  if (subs.delete(endpoint)) await persistSubs();
}

export function allSubs(): PushSub[] {
  return Array.from(subs.values());
}

/** Record any item not seen before. Returns how many were new. Append-only: one JSON object per
 *  line, so a partial write costs at most the last line rather than the whole ledger. */
export async function recordCorpus(
  items: { id: string; title: string; isShort: boolean }[],
  now = Date.now(),
): Promise<number> {
  const fresh = items.filter((it) => it.id && !corpusIds.has(it.id));
  if (!fresh.length) return 0;
  const lines: string[] = [];
  for (const it of fresh) {
    const e: CorpusEntry = { id: it.id, title: it.title, isShort: it.isShort, firstSeen: now };
    corpusIds.add(e.id);
    corpus.push(e);
    lines.push(JSON.stringify(e));
  }
  if (corpusFile) await Deno.writeTextFile(corpusFile, lines.join("\n") + "\n", { append: true });
  return fresh.length;
}

export function getCorpus(since = 0): CorpusEntry[] {
  return since ? corpus.filter((e) => e.firstSeen >= since) : corpus.slice();
}

export function corpusSize(): number { return corpus.length; }

/** Was anything watched in (from, to]? The behavioural endpoint every probe is scored against —
 *  observed from the corpus, so an UNANSWERED probe still yields an outcome. */
export function corpusActivityBetween(from: number, to: number): boolean {
  return corpus.some((e) => e.firstSeen > from && e.firstSeen <= to);
}
