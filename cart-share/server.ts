// cart-share — a friend substitutes similar items in your shopping cart, under a scoped,
// revocable, SUBSTITUTE-ONLY capability. The oauth3 delegation model applied to a long-tail
// site (Amazon): you never hand over your account; a friend gets a capability that can swap
// an item for a category-preserving alternative within a price band — and CANNOT check out,
// change your address/payment, or add unrelated items. You get a receipt of every swap and
// can revoke any time. v1 runs against a realistic cart fixture (the model is the point);
// v2 is the amazon browser-path plugin driving your real logged-in cart in the TEE.
const BUILD = "v1";

interface Item { id: string; name: string; cat: string; price: number; qty: number; organic: boolean }
interface Sub { name: string; price: number; organic: boolean; why: string }
// A realistic grocery cart + a curated "organic / similar" substitution per line.
const seedCart = (): Item[] => [
  { id: "milk", name: "Almond Breeze Almond Milk, 64oz", cat: "dairy-alt", price: 3.79, qty: 2, organic: false },
  { id: "eggs", name: "Large Eggs, dozen", cat: "eggs", price: 3.29, qty: 1, organic: false },
  { id: "bananas", name: "Bananas, bunch", cat: "produce", price: 1.99, qty: 1, organic: false },
  { id: "chicken", name: "Chicken Breast, 2 lb", cat: "meat", price: 9.49, qty: 1, organic: false },
  { id: "sauce", name: "Barilla Marinara Sauce, 24oz", cat: "pantry", price: 3.49, qty: 2, organic: false },
  { id: "coffee", name: "Folgers Ground Coffee, 25oz", cat: "coffee", price: 8.99, qty: 1, organic: false },
];
const SUBS: Record<string, Sub> = {
  milk: { name: "365 Organic Almond Milk, 64oz", price: 4.49, organic: true, why: "same category (dairy-alt), organic, +$0.70" },
  eggs: { name: "Organic Free-Range Large Eggs, dozen", price: 5.99, organic: true, why: "same category (eggs), organic, +$2.70" },
  bananas: { name: "Organic Bananas, bunch", price: 2.49, organic: true, why: "same category (produce), organic, +$0.50" },
  chicken: { name: "Organic Chicken Breast, 2 lb", price: 13.99, organic: true, why: "same category (meat), organic, +$4.50" },
  sauce: { name: "365 Organic Marinara Sauce, 24oz", price: 4.29, organic: true, why: "same category (pantry), organic, +$0.80" },
  coffee: { name: "Organic Peru Ground Coffee, 25oz", price: 12.49, organic: true, why: "same category (coffee), organic, +$3.50" },
};
const PRICE_BAND = 0.75; // a substitute may cost at most +75% of the original — a scope caveat

// --- state (in-memory; one cart for the demo) ---
let cart = seedCart();
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
  if (req.method === "GET" && path === "/health") return json({ ok: true, build: BUILD });

  // owner view of the cart + receipt + grant state
  if (req.method === "GET" && path === "/cart") {
    return json({ cart, total: +cart.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2), receipt, checkedOut, shared: !!grant && !revoked.has(grant.token) });
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

  // reset the demo
  if (req.method === "POST" && path === "/reset") {
    cart = seedCart();
    revoked.clear();
    grant = null;
    receipt.length = 0;
    checkedOut = false;
    return json({ ok: true });
  }

  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  Deno.serve({ port: 3000 }, (req) => handler(req, { env: {}, dataDir: "./.data" }));
}
