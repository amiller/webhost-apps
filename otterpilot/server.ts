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

async function nodeLive(after: number, tok?: string): Promise<any> {
  const t = tok || TOKEN;
  if (!t) throw new Error("OAUTH3_TOKEN not set — mint an otter token and set it on this project");
  const r = await fetch(`${NODE}/api/otter/live?after=${after}`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) throw new Error(`node /otter/live ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).data;
}

async function latestSlide(): Promise<string | null> {
  const d = await nodeLive(0);
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
    try {
      const d = await nodeLive(Number(url.searchParams.get("after") || "0") || 0, clientToken(req, url));
      if (d?.images) d.images = d.images.map((im: any) => ({ offset: im.offset, src: `frame?u=${b64url(im.url)}` }));
      return json(d);
    } catch (e) {
      return json({ error: `${(e as Error).message}` });
    }
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
