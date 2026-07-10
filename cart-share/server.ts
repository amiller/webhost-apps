// cart-share — a friend substitutes similar items in your shopping cart, under a scoped,
// revocable, SUBSTITUTE-ONLY capability. The oauth3 delegation model applied to a long-tail
// site (Amazon): you never hand over your account; a friend gets a capability that can swap
// an item for a category-preserving alternative within a price band — and CANNOT check out,
// change your address/payment, or add unrelated items. You get a receipt of every swap and
// can revoke any time. v1 runs against a realistic cart fixture (the model is the point);
// v2 is the amazon browser-path plugin driving your real logged-in cart in the TEE.
const BUILD = "v1";

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
// what to fill the cart with: a realistic base item + its organic swap, both real amazon listings.
const CATALOG = [
  { id: "milk", cat: "dairy-alt", base: "almond breeze almond milk", organic: "365 organic almond milk", qty: 2 },
  { id: "eggs", cat: "eggs", base: "eggland's best large eggs", organic: "vital farms organic eggs", qty: 1 },
  { id: "coffee", cat: "coffee", base: "folgers ground coffee", organic: "organic ground coffee", qty: 1 },
  { id: "sauce", cat: "pantry", base: "barilla marinara sauce", organic: "organic marinara sauce", qty: 2 },
  { id: "peanutbutter", cat: "pantry", base: "jif peanut butter", organic: "organic peanut butter", qty: 1 },
  { id: "oats", cat: "breakfast", base: "quaker oats", organic: "organic rolled oats", qty: 1 },
];
let cartSource: "amazon" | "fixture" = "fixture";
// A realistic grocery cart + a curated "organic / similar" substitution per line.
const PRICE_BAND = 1.5; // a substitute may cost at most +150% of the original (real amazon prices vary)

// fixture fallback ONLY if amazon is unreachable — clearly flagged via cartSource.
const fixtureCart = (): Item[] => [
  { id: "milk", name: "Almond Breeze Almond Milk, 64oz", cat: "dairy-alt", price: 3.79, qty: 2, organic: false },
  { id: "eggs", name: "Large Eggs, dozen", cat: "eggs", price: 3.29, qty: 1, organic: false },
  { id: "coffee", name: "Folgers Ground Coffee, 25oz", cat: "coffee", price: 8.99, qty: 1, organic: false },
];
const fixtureSubs: Record<string, Sub> = {
  milk: { name: "365 Organic Almond Milk, 64oz", price: 4.49, organic: true, why: "same category (dairy-alt), organic" },
  eggs: { name: "Organic Free-Range Large Eggs, dozen", price: 5.99, organic: true, why: "same category (eggs), organic" },
  coffee: { name: "Organic Peru Ground Coffee, 25oz", price: 12.49, organic: true, why: "same category (coffee), organic" },
};

// --- state (in-memory; one cart for the demo) ---
let cart: Item[] = [];
let SUBS: Record<string, Sub> = {};
let built = false;

// Build the cart from REAL amazon listings: for each catalog line, the base product and its
// organic swap are top live search results (real name, price, ASIN). Falls back to the fixture
// (clearly flagged) if amazon is unreachable from the pod.
async function buildRealCart(): Promise<void> {
  const items: Item[] = [];
  const subs: Record<string, Sub> = {};
  for (const c of CATALOG) {
    const [base, org] = await Promise.all([amazonSearch(c.base), amazonSearch(`${c.organic} organic`)]);
    const b = base.find((p) => p.price > 0.5 && p.name.length > 18);
    const o = org.find((p) => /organic/i.test(p.name) && p.price > 0.5) || org.find((p) => p.price > 0.5);
    if (!b || !o) continue;
    items.push({ id: c.id, name: b.name.slice(0, 78), cat: c.cat, price: b.price, qty: c.qty, organic: false, asin: b.asin });
    subs[c.id] = { name: o.name.slice(0, 78), price: o.price, organic: true, asin: o.asin, why: `same category (${c.cat}), organic · real amazon listing` };
  }
  if (items.length < 3) throw new Error("too few amazon results");
  cart = items;
  SUBS = subs;
  cartSource = "amazon";
}
async function ensureCart(): Promise<void> {
  if (built) return;
  built = true;
  try { await buildRealCart(); } catch (_e) { cart = fixtureCart(); SUBS = fixtureSubs; cartSource = "fixture"; }
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

export default async function handler(req: Request, _ctx: { env: Record<string, string>; dataDir: string }): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/cart-share/, "") || "/";

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(await readStatic("index.html"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (req.method === "GET" && path === "/health") {
    await ensureCart();
    return json({ ok: true, build: BUILD, source: cartSource, items: cart.length });
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
    built = false;
    revoked.clear();
    grant = null;
    receipt.length = 0;
    checkedOut = false;
    await ensureCart();
    return json({ source: cartSource, items: cart.length });
  }

  await ensureCart();

  // owner view of the cart + receipt + grant state
  if (req.method === "GET" && path === "/cart") {
    return json({ source: cartSource, cart, total: +cart.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2), receipt, checkedOut, shared: !!grant && !revoked.has(grant.token) });
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
    revoked.clear();
    grant = null;
    receipt.length = 0;
    checkedOut = false;
    await ensureCart();
    return json({ ok: true, source: cartSource });
  }

  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  Deno.serve({ port: 3000 }, (req) => handler(req, { env: {}, dataDir: "./.data" }));
}
