// OAuth3 client — reads YouTube history via the oauth3-sdk. Feedling gets its scoped token
// through the connect() handshake (web fallback: the user approves feedling in their signed-in
// pod room), then reads via plugin("youtube").list(). The handshake is driven explicitly by the
// poll loop (stepConnect) rather than the SDK's one-shot blocking connect(), so disconnect /
// reconnect are race-free for a long-running service. The token is persisted by the caller.
import { oauth3, type Oauth3Client } from "./sdk/index.ts";
import type { PluginItem } from "./sdk/types.ts";

export interface ShortCheckResult {
  watching: boolean;
  newShorts: number;
  shortsCount: number;
  /** Every item on the history page (shorts + regular videos). Logged for observability; NOT
   *  the watch signal — the youtube plugin parses only the initial ytInitialData render
   *  (render-window-limited), so for an established account this stays flat even right after a
   *  new watch. See `headId` for the robust signal. */
  totalCount: number;
  /** The topmost (most-recently-watched) history item's id. A new watch — regular, short, or a
   *  rewatch — lands at position 0, so a headId change is the render-window-robust signal that
   *  verbose/test mode keys activity off of. */
  headId: string;
  /** Honest only when the youtube plugin surfaces a per-item watched-at into `item.date`.
   *  False ⇒ the history page carries no dates, so `videosToday` is the WHOLE page and any
   *  "today" label would be a lie; callers must relabel it "history (all)". */
  todayHonest: boolean;
  videosToday: number;
  shorts: { id: string; title: string; date?: string }[];
  checked: string;
  elapsed: string;
}

export interface ConnState { connected: boolean; approveUrl: string; error: string }

let client: Oauth3Client | null = null;
let node = "";
let conn: ConnState = { connected: false, approveUrl: "", error: "" };
let pendingReq = "";
let persistToken: (t: string) => void = () => {};
let clearToken: () => void = () => {};
// Seen short IDs, not a count: the history page is a fixed ~200-item sliding window, so a newly
// watched short evicts an older item. Since most of the window is shorts, the COUNT stays flat
// (or drops) even when new shorts arrive. Diff the ID set instead.
let prevIds = new Set<string>(), primed = false;

/** Local-midnight ms (the container clock — set TZ to your timezone). Only meaningful when
 *  the youtube plugin stamps each item with a watched-at, so "today" can be enforced honestly. */
function startOfDayMs(): number {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
}

/** Count non-short items watched at/after the given local start-of-day (ms). Pure: an item
 *  without a `date` contributes nothing. Callers decide what to show when NO item carries a
 *  date — that's the `todayHonest` flag, not this count. */
export function countVideosToday(items: (PluginItem & { meta?: { isShort?: boolean } })[], sod: number): number {
  return items.filter((it) => !it.meta?.isShort && it.date && Date.parse(it.date) >= sod).length;
}

export function connState(): ConnState { return conn; }

/** Configure with the pod node + an already-approved token (from env or persisted). Without a
 *  token, the poll loop drives the connect handshake via stepConnect(). */
export function configureOauth3(nodeUrl: string, token: string, persist: (t: string) => void, clear: () => void = () => {}) {
  node = nodeUrl;
  persistToken = persist;
  clearToken = clear;
  client = oauth3({ node, token: token || undefined });
  conn = { connected: !!token, approveUrl: "", error: "" };
  pendingReq = "";
}

/** Log out: drop the persisted token and reset so a fresh handshake starts (a different account
 *  or refreshed cookies can then be approved). */
export function disconnect() {
  clearToken();
  client = oauth3({ node });
  conn = { connected: false, approveUrl: "", error: "" };
  pendingReq = "";
  prevIds = new Set();
  primed = false;
}

/** Advance the connect handshake one step. Called by the poll loop while not connected:
 *  first call opens a request (surfacing an approve URL), later calls poll for approval. */
export async function stepConnect(): Promise<void> {
  if (!node) return;
  try {
    if (!pendingReq) {
      const r = await fetch(`${node}/api/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugin: "youtube", app: "feedling-web" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { conn = { connected: false, approveUrl: "", error: j.error || `connect ${r.status}` }; return; }
      pendingReq = j.requestId;
      conn = { connected: false, approveUrl: j.approveUrl, error: "" };
      return;
    }
    const s = await (await fetch(`${node}/api/connect/${pendingReq}`)).json();
    if (s.status === "approved") {
      client = oauth3({ node, token: s.token });
      persistToken(s.token);
      conn = { connected: true, approveUrl: "", error: "" };
      pendingReq = "";
    } else if (s.status === "denied") {
      pendingReq = "";
      conn = { connected: false, approveUrl: "", error: "approval denied — retrying" };
    }
    // otherwise still pending — keep the approve URL visible
  } catch (e) {
    conn = { connected: false, approveUrl: conn.approveUrl, error: (e as Error).message };
  }
}

/** The raw current history page, verbatim — every item the youtube plugin returns, not just shorts. */
export async function rawHistory(): Promise<{ id: string; title: string; date?: string; isShort: boolean }[]> {
  if (!client || !conn.connected) {
    throw new Error(conn.approveUrl ? `awaiting approval — ${conn.approveUrl}` : (conn.error || "connecting…"));
  }
  const items = (await client.plugin("youtube").list()) as (PluginItem & { meta?: { isShort?: boolean } })[];
  return items.map((it) => ({ id: it.id, title: it.title, date: it.date, isShort: !!it.meta?.isShort }));
}

export async function shortCheck(): Promise<ShortCheckResult> {
  if (!client || !conn.connected) {
    throw new Error(conn.approveUrl ? `awaiting approval — ${conn.approveUrl}` : (conn.error || "connecting…"));
  }
  const t0 = Date.now();
  let items: (PluginItem & { meta?: { isShort?: boolean } })[];
  try {
    items = (await client.plugin("youtube").list()) as typeof items;
  } catch (e: any) {
    if (e?.status === 401) disconnect(); // scoped token rejected — drop it and re-handshake
    throw e;
  }
  const shorts = items.filter((it) => it.meta?.isShort);
  const shortsCount = shorts.length;
  const fresh = shorts.filter((it) => !prevIds.has(it.id));
  const newShorts = primed ? fresh.length : 0; // first poll only baselines
  prevIds = new Set(shorts.map((it) => it.id));
  primed = true;

  // "today" is only honest when the plugin gives us a per-item watched-at (item.date). Without
  // those dates we cannot tell today's watches from the rest of the history page, so videosToday
  // falls back to the whole-page non-short count and the UI MUST relabel it "history (all)" —
  // todayHonest = false. The date contract lives in oauth3-server's youtube plugin (parseHistory).
  const sod = startOfDayMs();
  const todayHonest = items.some((it) => it.date);
  return {
    watching: newShorts > 0,
    newShorts,
    shortsCount,
    totalCount: items.length,
    headId: items[0]?.id ?? "",
    todayHonest,
    videosToday: todayHonest ? countVideosToday(items, sod) : (items.length - shortsCount),
    shorts: fresh.map((it) => ({ id: it.id, title: it.title, date: it.date })),
    checked: new Date().toISOString(),
    elapsed: `${Date.now() - t0}ms`,
  };
}
