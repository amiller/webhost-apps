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
  videosToday: number;
  shorts: { id: string; title: string }[];
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
let prevCount = 0, primed = false;

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
  prevCount = 0;
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
        body: JSON.stringify({ plugin: "youtube", app: "feedling" }),
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
  const newShorts = primed ? Math.max(0, shortsCount - prevCount) : 0;
  prevCount = shortsCount;
  primed = true;
  return {
    watching: newShorts > 0,
    newShorts,
    shortsCount,
    videosToday: items.length - shortsCount,
    shorts: shorts.map((it) => ({ id: it.id, title: it.title })),
    checked: new Date().toISOString(),
    elapsed: `${Date.now() - t0}ms`,
  };
}
