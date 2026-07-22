// otterpilot — follow a live Otter meeting (transcript + shared-screen frames) with a
// "what were we talking about?" recap button. Ported from planning/scripts/otter_web,
// which read the raw Otter cookie out of local Chrome. Here the meeting feed and the
// frames come through a SCOPED, revocable token to the oauth3 node — this app never
// holds your Otter cookie, and the browser only ever talks to this app (the token stays
// server-side). The recap engine is your own NEAR AI Cloud key.
//
// Env (ctx.env): OAUTH3_NODE (default the pod), OAUTH3_TOKEN (owner-minted otter token),
//                NEAR_KEY, optional NEAR_MODEL / NEAR_VL_MODEL.

let NODE = "", TOKEN = "", NEAR_KEY = "";
let TEXT_MODEL = "deepseek-ai/DeepSeek-V4-Flash", VL_MODEL = "google/gemini-2.5-flash";
const NEAR_URL = "https://cloud-api.near.ai/v1/chat/completions";
let ready = false;

function initOnce(env: Record<string, string>): void {
  if (ready) return;
  NODE = (env.OAUTH3_NODE || "https://pod.dstack.soc1024.com/oauth3").replace(/\/$/, "");
  TOKEN = env.OAUTH3_TOKEN || "";
  NEAR_KEY = env.NEAR_KEY || "";
  TEXT_MODEL = env.NEAR_MODEL || TEXT_MODEL;
  VL_MODEL = env.NEAR_VL_MODEL || VL_MODEL;
  ready = true;
}

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_");

async function readStatic(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`./public/${name}`, import.meta.url));
}

// The oauth3 node holds the sealed cookie; we present the scoped token.
// A follow-mode request may carry a scoped, read-only token (minted by the owner from the
// browser via the OAuth3 extension) in the Authorization header or ?token=. For /live and
// /frame we forward THAT token to the node instead of the owner token — the follower only
// ever reads through their scoped cap, and the owner's otter jar stays sealed in the TEE.
// /recap stays owner-only: it never accepts a client token (caps are read /live + /frame).
function clientToken(req: Request, url: URL): string {
  const a = req.headers.get("authorization") || "";
  if (/^bearer /i.test(a)) return a.replace(/^bearer /i, "").trim();
  return url.searchParams.get("token") || "";
}

// otterpilot must not echo the node's raw HTTP error into the meeting header — that IS the
// bug: prod showed `node /otter/live 409: {"error":"no jar synced for otter"}` (and, per #61,
// `409 {"error":"challenge_pending",...}`). So nodeLive returns a CATEGORIZED outcome the
// header renders as a truthful status, never an alarm:
//   ok               — {data} from the node (a live meeting, or {live:false} when none runs)
//   no-otter         — 409 'no jar synced' / 'not logged in': Otter isn't connected for the
//                      subject this token reads as (a setup/rebind problem — root cause of
//                      the original prod 409). Truthful status, NOT masked as 'no live meeting'.
//   challenge-pending — 409 'challenge_pending' (RFC 0005 step-up): the oauth3 core held this
//                      read for out-of-band approval. Carries the challengeId so the page can
//                      poll /challenge/:id and RESUME the moment the owner approves, instead
//                      of going down. This is the #61 prod-down cause: a standing server-app
//                      token re-triggers first-use step-up on every core restart, so the app
//                      must handle it (legible approve-prompt + recover), never alarm on it.
//   auth             — 401/403: token rejected (revoked/stale).
//   node-unreachable / error — anything else, surfaced short.
type LiveOutcome =
  | { ok: true; data: any }
  | { ok: false; state: "no-otter" | "auth" | "challenge-pending" | "node-unreachable" | "error"; detail: string; challengeId?: string };

async function nodeLive(after: number, tok?: string): Promise<LiveOutcome> {
  const t = tok || TOKEN;
  if (!t) return { ok: false, state: "error", detail: "no Otter token set (OAUTH3_TOKEN) — mint one and set it on this project" };
  let r: Response;
  try {
    r = await fetch(`${NODE}/api/otter/live?after=${after}`, { headers: { Authorization: `Bearer ${t}` } });
  } catch (e) {
    return { ok: false, state: "node-unreachable", detail: "couldn't reach the oauth3 node (" + ((e as Error)?.message || e) + ")" };
  }
  if (r.ok) return { ok: true, data: (await r.json()).data };
  const body = await r.text().catch(() => "");
  if (r.status === 401 || r.status === 403) return { ok: false, state: "auth", detail: "Otter token was rejected — re-mint it" };
  if (r.status === 409) {
    // Step-up (RFC 0005) is checked BEFORE the no-otter 409: both are 409 but only the
    // step-up body carries `error: "challenge_pending"` + a challengeId. Parse, don't
    // regex — the challengeId is what lets the page recover, so read it precisely.
    let parsed: any = null;
    try { parsed = JSON.parse(body); } catch (_) { /* not JSON — falls through to no-otter */ }
    if (parsed && parsed.error === "challenge_pending" && parsed.challengeId) {
      return { ok: false, state: "challenge-pending", detail: "Otter read is waiting on step-up approval", challengeId: parsed.challengeId };
    }
    if (/no jar synced|not logged in/i.test(body)) {
      return { ok: false, state: "no-otter", detail: /not logged in/i.test(body) ? "Otter session isn't logged in" : "Otter isn't connected to this instance yet" };
    }
  }
  return { ok: false, state: "error", detail: "otter node returned " + r.status };
}

// "state the subject it read as": the node resolves otterpilot's token to a subject and
// reads THAT subject's jar — a mis-bound subject is the root cause of the prod 409 (token
// reads as 'owner' while the jar lives under the operator's real identity). The node does
// NOT expose the resolved subject for a scoped token, so otterpilot states the credential
// identity it presented (masked, never the full secret) — enough for the operator to see
// which token — and thus which subject — otterpilot read as, and rebind it if it's wrong.
// See issue #44.
function readingAs(tok: string): string {
  const t = tok || TOKEN;
  if (!t) return "no token set";
  // scoped tokens are opaque `tok-<plugin>-<rand>`; the raw owner secret reads as 'owner'.
  return /^tok-/.test(t) ? "scoped otter token …" + t.slice(-4) : "owner secret → subject 'owner'";
}

async function latestSlide(): Promise<string | null> {
  const res = await nodeLive(0);
  if (!res.ok) return null;
  const d = res.data;
  const imgs = d?.images ?? [];
  if (!d?.live || !imgs.length) return null;
  const r = await fetch(`${NODE}/api/otter/frame?u=${encodeURIComponent(b64url(imgs[imgs.length - 1].url))}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) return null;
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return `data:${r.headers.get("content-type") || "image/png"};base64,${btoa(bin)}`;
}

async function recap(text: string, useSlide: boolean): Promise<unknown> {
  if (!NEAR_KEY) throw new Error("NEAR_KEY not set");
  const sys = "You are catching someone up on a live meeting they glanced away from. From the recent transcript " +
    "(may have fragments/mis-hears) and, if provided, the current shared screen, answer 'what were we just " +
    "talking about?' Be tight and concrete: 2-4 short bullets on the current topic(s), plus any question or " +
    "decision on the table right now. If a slide is shown, ground the recap in it. No preamble.";
  const slide = useSlide ? await latestSlide() : null;
  const user = `Recent transcript:\n${text}\n\nWhat were we just talking about?`;
  const content = slide ? [{ type: "text", text: user }, { type: "image_url", image_url: { url: slide } }] : user;
  const r = await fetch(NEAR_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${NEAR_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: slide ? VL_MODEL : TEXT_MODEL,
      max_tokens: 450,
      temperature: 0.3,
      messages: [{ role: "system", content: sys }, { role: "user", content }],
    }),
  });
  if (!r.ok) throw new Error(`near ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const out = (await r.json()).choices[0].message.content.trim();
  return { summary: out, used_slide: !!slide };
}

export default async function handler(req: Request, ctx: { env: Record<string, string> }): Promise<Response> {
  initOnce(ctx.env || {});
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(await readStatic("index.html"), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // Live feed: node segments + frame urls rewritten to our own proxied path (the token
  // never leaves the server, so <img> can't carry it — we relay).
  if (req.method === "GET" && path === "/live") {
    const tok = clientToken(req, url);
    const res = await nodeLive(Number(url.searchParams.get("after") || "0") || 0, tok);
    if (res.ok) {
      const d = res.data;
      if (d?.images) d.images = d.images.map((im: any) => ({ offset: im.offset, src: `frame?u=${b64url(im.url)}` }));
      return json(d);
    }
    // truthful, categorized state for the header — never the raw node HTTP error.
    // challenge_id rides along only for the challenge-pending state (the page polls it).
    return json({ live: false, state: res.state, message: res.detail, reading_as: readingAs(tok), challenge_id: res.challengeId });
  }

  // Step-up challenge status proxy (RFC 0005). The browser can't reach the node's
  // /api/challenge/:id directly (CORS, and a follower holds no bearer for the node), so
  // otterpilot relays it and normalizes the three outcomes the core emits — approved
  // (retry will succeed), pending (keep polling), denied/expired (terminal) — plus
  // unknown for a missing/expunged challenge. The live poller uses this to RESUME the
  // feed automatically once the owner approves, instead of going down on a step-up (#61).
  if (req.method === "GET" && path.startsWith("/challenge/")) {
    const id = decodeURIComponent(path.slice("/challenge/".length));
    if (!id) return json({ status: "unknown", detail: "no challenge id" });
    let r: Response;
    try {
      r = await fetch(`${NODE}/api/challenge/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${clientToken(req, url) || TOKEN}` },
      });
    } catch (e) {
      return json({ status: "unknown", detail: "couldn't reach the oauth3 node (" + ((e as Error)?.message || e) + ")" });
    }
    if (r.status === 404) return json({ status: "unknown", detail: "challenge not found — it expired or was already decided" });
    const j = await r.json().catch(() => null);
    const status = (j && (j.status || (j.data && j.data.status))) || (r.ok ? "pending" : "unknown");
    return json({ status, expiresAt: (j && j.expiresAt) || undefined, raw: j });
  }

  // Frame relay: browser -> /frame?u=<b64url(imageurl)> -> node /otter/frame (bearer) -> bytes.
  if (req.method === "GET" && path === "/frame") {
    const u = url.searchParams.get("u") || "";
    const r = await fetch(`${NODE}/api/otter/frame?u=${encodeURIComponent(u)}`, {
      headers: { Authorization: `Bearer ${clientToken(req, url) || TOKEN}` },
    });
    if (!r.ok) return new Response(await r.text(), { status: 502 });
    return new Response(r.body, { headers: { "content-type": r.headers.get("content-type") || "image/png" } });
  }

  if (req.method === "POST" && path === "/recap") {
    const body = await req.json().catch(() => ({}));
    try {
      return json(await recap(body.text || "", body.use_slide !== false));
    } catch (e) {
      return json({ error: `${(e as Error).message}` });
    }
  }

  return new Response("not found", { status: 404 });
}
