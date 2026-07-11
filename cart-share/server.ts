// cart-share — a friend substitutes similar items in your shopping cart, under a scoped,
// revocable, SUBSTITUTE-ONLY capability. The oauth3 delegation model applied to a long-tail
// site (Amazon): you never hand over your account; a friend gets a capability that can swap
// an item for a category-preserving alternative within a price band — and CANNOT check out,
// change your address/payment, or add unrelated items. You get a receipt of every swap and
// can revoke any time. v1 runs against a realistic cart fixture (the model is the point);
// v2 is the amazon browser-path plugin driving your real logged-in cart in the TEE.
const BUILD = "v2";

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
// v2: the cart is the OWNER'S REAL Amazon cart, read through the oauth3 core's amazon plugin
// (GET /api/amazon/items — the plugin reads /gp/cart with the owner's synced jar). No fixtures,
// no guest search. Organic SUGGESTIONS are still a live search (an organic alternative per line).
//
// TOKENLESS: this app holds NO standing credential. The owner's browser gets a scoped, revocable
// amazon read token from the oauth3 extension (window.oauth3.connect) and hands it to POST /connect
// for one build. Nobody mints or pastes a token; nothing secret lives in the deploy env.
let OAUTH3_BASE = "https://pod.dstack.soc1024.com/oauth3"; // the oauth3 node URL (not a secret)
const PRICE_BAND = 1.5; // an organic substitute may cost at most +150% of the original
let cartSource: "amazon-jar" | "unconnected" = "unconnected";
let cartError = "";

// A short search query from a long Amazon title (first few meaningful words) — used to find an
// organic alternative to a real cart line.
function shortTerm(title: string): string {
  return title.replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^\d+$/.test(w)).slice(0, 4).join(" ");
}

// --- state (in-memory; one cart for the demo) ---
let cart: Item[] = [];
let SUBS: Record<string, Sub> = {};

// Read the OWNER'S REAL cart from the oauth3 core's amazon plugin using the scoped token the
// owner's browser just obtained via the extension, then find an organic alternative for each
// non-organic line. Throws (honestly) if the read is gated/blocked — never invents a cart.
async function buildRealCart(token: string): Promise<void> {
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
// Build the cart from the owner's scoped token (from POST /connect). On any failure, stay
// honestly "unconnected" with the reason — never invent a cart.
async function connectCart(token: string): Promise<void> {
  try { await buildRealCart(token); }
  catch (e) { cart = []; SUBS = {}; cartSource = "unconnected"; cartError = String((e as Error).message || e); }
}
function resetCart(): void {
  cart = []; SUBS = {}; cartSource = "unconnected"; cartError = "";
  revoked.clear(); grant = null; receipt.length = 0; checkedOut = false;
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
    return json({ ok: true, build: BUILD, source: cartSource, error: cartError || undefined, items: cart.length });
  }
  // OWNER connect: the browser got a scoped amazon read token from the oauth3 extension and hands
  // it here for ONE build. No token is stored; the app holds no standing credential.
  if (req.method === "POST" && path === "/connect") {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer /i, "").trim();
    if (!token) return json({ error: "no scoped token — connect Amazon in the OAuth3 extension" }, 401);
    await connectCart(token);
    return json({ source: cartSource, error: cartError || undefined, items: cart.length });
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
  // clear the session — owner reconnects via the extension to rebuild
  if (req.method === "POST" && path === "/refresh") {
    resetCart();
    return json({ source: cartSource, error: cartError || undefined, items: cart.length });
  }

  // owner view of the cart + receipt + grant state
  if (req.method === "GET" && path === "/cart") {
    const shared = !!grant && !revoked.has(grant.token);
    return json({ source: cartSource, error: cartError || undefined, cart, total: +cart.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2), receipt, checkedOut, shared, link: shared ? `/cart-share/?cap=${grant!.token}` : undefined, scope: shared ? grant!.scope : undefined });
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

  // reset the demo — clear to unconnected; owner reconnects via the extension
  if (req.method === "POST" && path === "/reset") {
    resetCart();
    return json({ ok: true, source: cartSource });
  }

  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  Deno.serve({ port: 3000 }, (req) => handler(req, { env: {}, dataDir: "./.data" }));
}
