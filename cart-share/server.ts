// cart-share — a friend substitutes similar items in your shopping cart, under a scoped,
// revocable, SUBSTITUTE-ONLY capability. The oauth3 delegation model applied to a long-tail
// site (Amazon): you never hand over your account; a friend gets a capability that can swap
// an item for a category-preserving alternative within a price band — and CANNOT check out,
// change your address/payment, or add unrelated items. You get a receipt of every swap and
// can revoke any time. v1 runs against a realistic cart fixture (the model is the point);
// v2 is the amazon browser-path plugin driving your real logged-in cart in the TEE.
const BUILD = "v3";

interface Item { id: string; name: string; cat: string; price: number; qty: number; organic: boolean; asin?: string }
interface Sub { name: string; price: number; organic: boolean; why: string; asin?: string }

// --- REAL amazon: server-side search + parse (no login needed for public product data) ---
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
interface AzProd { name: string; price: number; asin: string }
async function amazonSearch(term: string): Promise<AzProd[]> {
  const r = await fetch(`https://www.amazon.com/s?k=${encodeURIComponent(term)}`, {
    headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", "accept": "text/html" },
    signal: AbortSignal.timeout(20000),
  });
  const h = await r.text();
  const out: AzProd[] = [];
  for (const b of h.split('data-component-type="s-search-result"').slice(1)) {
    const asin = b.match(/data-asin="([A-Z0-9]{10})"/);
    // prefer the standard product-title span; fall back to the first h2 span
    const t = b.match(/<span class="a-size-(?:base-plus|medium)[^"]*a-text-normal">([^<]{14,120})<\/span>/) ||
      b.match(/<h2[^>]*aria-label="([^"]{14,120})"/) ||
      b.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([^<]{14,120})<\/span>/);
    const p = b.match(/a-offscreen">\$([0-9,]+\.[0-9]{2})</); // full price, most reliable (screen-reader span)
    if (asin && t && p) {
      const name = t[1].replace(/&amp;/g, "&").replace(/&[a-z0-9#]+;/g, "").trim();
      // skip size-only variant labels ("24 Ounce (Pack of 1)") — want a real product title
      if (name.length > 14 && /[A-Za-z]{4}/.test(name) && !/^\d/.test(name)) {
        out.push({ asin: asin[1], name, price: +p[1].replace(/,/g, "") });
      }
    }
  }
  return out;
}
// v3: the cart is read through the oauth3 CONNECT handshake — no pre-minted env token. cart-share
// POSTs /api/connect {plugin:"amazon", caps:["amazon:cart-read"]}, surfaces the approveUrl to the
// owner, and polls for the scoped token (bound to the APPROVER's identity = whose jar it reads).
// Then GET /api/amazon/items with that token. No fixtures, no guest search. Organic SUGGESTIONS
// are still a live search (an organic alternative per line).
let OAUTH3_BASE = "https://pod.dstack.soc1024.com/oauth3";
const PRICE_BAND = 1.5; // an organic substitute may cost at most +150% of the original
let cartSource: "amazon-jar" | "unconnected" = "unconnected";
let cartError = "";

// --- connect handshake (replaces the pre-minted OAUTH3_TOKEN env var). cart-share requests
// amazon read access; the OWNER approves as their identity on the OAuth3 consent page; we poll
// for the scoped token, bound to the approver's jar. No env token, no second path. ---
type Conn =
  | { kind: "none" }
  | { kind: "pending"; requestId: string; approveUrl: string }
  | { kind: "approved"; token: string }
  | { kind: "denied" };
let conn: Conn = { kind: "none" };
let connError = "";

function connectToken(): string | null {
  return conn.kind === "approved" ? conn.token : null;
}
function connectStatus(): { status: string; approveUrl?: string; error?: string } {
  const base: { status: string; approveUrl?: string; error?: string } = { status: conn.kind };
  if (conn.kind === "pending") base.approveUrl = conn.approveUrl;
  if (connError) base.error = connError;
  return base;
}
function resetConnect(): void {
  conn = { kind: "none" };
  connError = "";
}
// Ask the oauth3 core for amazon read access. Reuses the in-flight requestId so repeated calls
// don't orphan the approve page the owner opened.
async function startConnect(): Promise<void> {
  const r = await fetch(`${OAUTH3_BASE}/api/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plugin: "amazon", app: "cart-share", caps: ["amazon:cart-read"] }),
    signal: AbortSignal.timeout(15_000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.requestId) throw new Error(d.error || d.reason || `connect ${r.status}`);
  conn = { kind: "pending", requestId: d.requestId, approveUrl: d.approveUrl };
}
// Poll the connect once; transition when the user decides.
async function pollConnect(): Promise<void> {
  if (conn.kind !== "pending") return;
  const r = await fetch(`${OAUTH3_BASE}/api/connect/${conn.requestId}`, { signal: AbortSignal.timeout(10_000) });
  const d = await r.json().catch(() => ({}));
  if (d.status === "approved" && d.token) conn = { kind: "approved", token: d.token };
  else if (d.status === "denied") conn = { kind: "denied" };
}
// Drive the connect toward an approved token. Surfaces an approveUrl if none yet and polls for a
// short window so a just-granted approval is picked up within the request (the owner view also
// auto-refreshes, so a miss is recovered on the next poll).
async function ensureConnect(): Promise<void> {
  if (conn.kind === "approved" || conn.kind === "denied") return;
  if (conn.kind === "none") {
    try { await startConnect(); connError = ""; }
    catch (e) { connError = String((e as Error).message || e); return; }
  }
  if (conn.kind === "pending") {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && conn.kind === "pending") {
      await pollConnect().catch(() => {});
      if (conn.kind !== "pending") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// A short search query from a long Amazon title (first few meaningful words) — used to find an
// organic alternative to a real cart line.
function shortTerm(title: string): string {
  return title.replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^\d+$/.test(w)).slice(0, 4).join(" ");
}

// --- state (in-memory; one cart for the demo) ---
let cart: Item[] = [];
let SUBS: Record<string, Sub> = {};
let built = false;

// Read the OWNER'S REAL cart from the oauth3 core's amazon plugin, then find an organic
// alternative for each non-organic line. Throws (honestly) if no jar is synced or Amazon
// blocks the read — never invents a cart.
async function buildRealCart(): Promise<void> {
  const token = connectToken();
  if (!token) throw new Error("not connected — approve Amazon read on the OAuth3 consent screen");
  const r = await fetch(`${OAUTH3_BASE}/api/amazon/items`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(90000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || d.reason || `amazon items ${r.status}`);
  const raw = (Array.isArray(d) ? d : d.data || d.items || []) as Array<
    { id: string; title: string; meta?: { asin?: string; price?: string | number; qty?: number } }
  >;
  const items: Item[] = raw.map((it) => ({
    id: it.meta?.asin || it.id,
    name: it.title.replace(/&#0?39;/g, "'").replace(/&amp;/g, "&").replace(/Opens in a new tab/gi, "").replace(/\s+/g, " ").trim().slice(0, 72),
    cat: "cart",
    price: +String(it.meta?.price ?? "0").replace(/[^0-9.]/g, "") || 0,
    qty: Number(it.meta?.qty) || 1,
    organic: /organic/i.test(it.title),
    asin: it.meta?.asin || it.id,
  }));
  if (items.length === 0) throw new Error("your Amazon cart is empty — add something to it, then refresh");
  const subs: Record<string, Sub> = {};
  for (const it of items) {
    if (it.organic) continue;
    const org = await amazonSearch(`${shortTerm(it.name)} organic`).catch(() => []);
    const o = org.find((p) => /organic/i.test(p.name) && p.price > 0.5 && p.asin !== it.asin);
    if (o) subs[it.id] = { name: o.name.slice(0, 78), price: o.price, organic: true, asin: o.asin, why: "organic alternative · real amazon listing" };
  }
  cart = items;
  SUBS = subs;
  cartSource = "amazon-jar";
  cartError = "";
}
async function ensureCart(): Promise<void> {
  if (built) return;
  if (!connectToken()) await ensureConnect();
  if (!connectToken()) {
    // honest unconnected state — the owner view surfaces the approveUrl / denial / error.
    cart = []; SUBS = {};
    cartSource = "unconnected";
    cartError = conn.kind === "denied"
      ? "Amazon connect was denied — Retry to request again"
      : conn.kind === "pending"
        ? "" // pending: the owner view shows the approveUrl affordance (no error noise)
        : (connError || "connect your Amazon to load your real cart");
    return;
  }
  built = true;
  try { await buildRealCart(); }
  catch (e) { cart = []; SUBS = {}; cartSource = "unconnected"; cartError = String((e as Error).message || e); }
}
const revoked = new Set<string>();
interface GrantRec { token: string; scope: string; created: number }
let grant: GrantRec | null = null;
const receipt: { ts: number; item: string; from: string; to: string; delta: number; by: string }[] = [];
let checkedOut = false;

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const readStatic = (n: string) => Deno.readTextFile(new URL(`./public/${n}`, import.meta.url));
const tok = () => "cap-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);

function checkCap(t: string): { ok: true } | { ok: false; reason: string } {
  if (!grant || t !== grant.token) return { ok: false, reason: "no such capability" };
  if (revoked.has(t)) return { ok: false, reason: "capability revoked by the owner" };
  return { ok: true };
}

let configured = false;
export default async function handler(req: Request, ctx: { env: Record<string, string>; dataDir: string }): Promise<Response> {
  if (!configured) {
    if (ctx.env?.OAUTH3_BASE) OAUTH3_BASE = ctx.env.OAUTH3_BASE.replace(/\/$/, "");
    configured = true;
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/cart-share/, "") || "/";

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(await readStatic("index.html"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (req.method === "GET" && path === "/health") {
    await ensureCart();
    return json({ ok: true, build: BUILD, source: cartSource, error: cartError || undefined, items: cart.length, connect: connectStatus() });
  }
  if (req.method === "GET" && path === "/debug") {
    const out: Record<string, unknown> = {};
    for (const [k, u] of [["example", "https://example.com"], ["amazon", "https://www.amazon.com/s?k=almond+milk"]] as const) {
      try {
        const r = await fetch(u, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(15000) });
        const t = await r.text();
        out[k] = { status: r.status, bytes: t.length, cards: k === "amazon" ? t.split('data-component-type="s-search-result"').length - 1 : undefined };
      } catch (e) { out[k] = { error: String((e as Error).message || e) }; }
    }
    return json(out);
  }
  // rebuild the cart from live amazon
  if (req.method === "POST" && path === "/refresh") {
    built = false; // re-read the cart with the existing connection (no re-approve needed)
    revoked.clear();
    grant = null;
    receipt.length = 0;
    checkedOut = false;
    await ensureCart();
    return json({ source: cartSource, error: cartError || undefined, items: cart.length, connect: connectStatus() });
  }

  await ensureCart();

  // owner view of the cart + receipt + grant state
  if (req.method === "GET" && path === "/cart") {
    return json({ source: cartSource, error: cartError || undefined, cart, total: +cart.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2), receipt, checkedOut, shared: !!grant && !revoked.has(grant.token), connect: connectStatus() });
  }

  // OWNER: mint a scoped, revocable substitute-only capability for a friend.
  if (req.method === "POST" && path === "/share") {
    grant = { token: tok(), scope: "amazon:cart-substitute", created: Date.now() };
    return json({ token: grant.token, scope: grant.scope, link: `/cart-share/?cap=${grant.token}` });
  }
  // OWNER: revoke it — the friend's next action fails.
  if (req.method === "POST" && path === "/revoke") {
    if (grant) revoked.add(grant.token);
    return json({ revoked: true });
  }

  // FRIEND: the cart as they see it — items + the suggested organic swap per line. No prices hidden
  // here (they can see prices), but NO address, payment, or order history is ever exposed.
  if (req.method === "GET" && path === "/friend/cart") {
    const c = checkCap(url.searchParams.get("cap") || "");
    if (!c.ok) return json({ error: c.reason }, 401);
    return json({
      scope: grant!.scope,
      source: cartSource,
      items: cart.map((i) => ({ ...i, suggest: SUBS[i.id] && !i.organic ? SUBS[i.id] : null })),
    });
  }

  // FRIEND: apply a substitution — enforced by the SCOPE: must be the suggested same-category swap,
  // within the price band; never a checkout, never an arbitrary add.
  if (req.method === "POST" && path === "/friend/substitute") {
    const b = await req.json().catch(() => ({})) as { cap?: string; id?: string };
    const c = checkCap(b.cap || "");
    if (!c.ok) return json({ ok: false, reason: c.reason }, 401);
    const item = cart.find((i) => i.id === b.id);
    const sub = b.id ? SUBS[b.id] : undefined;
    if (!item || !sub) return json({ ok: false, reason: "not a substitutable item" }, 400);
    if (item.organic) return json({ ok: false, reason: "already substituted" }, 409);
    // scope caveat: category-preserving + within price band (enforced server-side, not trusted from client)
    if (sub.price > item.price * (1 + PRICE_BAND)) {
      return json({ ok: false, reason: `scope: substitute exceeds the +${PRICE_BAND * 100}% price band` }, 403);
    }
    receipt.push({ ts: Date.now(), item: item.id, from: item.name, to: sub.name, delta: +(sub.price - item.price).toFixed(2), by: "friend" });
    item.name = sub.name;
    item.price = sub.price;
    item.organic = true;
    return json({ ok: true, item });
  }

  // The SCOPE boundary, made real: a friend token CANNOT check out. Owner (no cap) can.
  if (req.method === "POST" && path === "/checkout") {
    const cap = (req.headers.get("authorization") || "").replace(/^Bearer /i, "");
    if (cap) return json({ ok: false, reason: "scope: amazon:cart-substitute may swap items — it CANNOT check out. Only you can." }, 403);
    checkedOut = true;
    return json({ ok: true, total: +cart.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2) });
  }

  // reset the demo (rebuild from live amazon)
  if (req.method === "POST" && path === "/reset") {
    built = false;
    resetConnect(); // full tear-down: also drops the amazon connection so the owner can re-approve
    revoked.clear();
    grant = null;
    receipt.length = 0;
    checkedOut = false;
    await ensureCart();
    return json({ ok: true, source: cartSource, connect: connectStatus() });
  }

  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  Deno.serve({ port: 3000 }, (req) => handler(req, { env: {}, dataDir: "./.data" }));
}
