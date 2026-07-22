// screenshare-pet — a Picture-in-Picture pet that seems aware of your screen. The fun demo
// consumer of the screenshare change-signals family. Sibling of screenshare-debug, same
// three-file shape, but with ALL authorization machinery kept OUT (issue #73 non-goals):
// frames never leave the browser by default. oauth3 / consent / sinks are deliberately absent.
//
// The server is intentionally tiny: serve the capture client, a health probe, a pinned
// /version (Tier-1 evidence anchor), and two clearly-labelled DEV-ONLY loopback endpoints
// (/dev/echo, /dev/caption) used only when the operator turns on the "debug: mirror to sink"
// toggle. Those dev endpoints require NO consent and NO credential — they exist so the
// "mirror OFF ⇒ zero frame POSTs" acceptance can be demonstrated both ways. They are not a
// sink in the screenshare-debug sense (no grant, no storage, no trace); they echo a count and
// a canned caption and forget everything.
//
// Env (ctx.env): VERSION (git commit, injected at deploy), otherwise the short BUILD stamp.

const BUILD = "b1";

let ready = false;
let VERSION = "";

function initOnce(env: Record<string, string>): void {
  if (ready) return;
  VERSION = env.VERSION || "";
  ready = true;
}

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function readStatic(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`./public/${name}`, import.meta.url));
}

export default async function handler(req: Request, ctx: { env: Record<string, string> }): Promise<Response> {
  initOnce(ctx.env || {});
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(await readStatic("index.html"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  if (req.method === "GET" && path === "/health") {
    return json({ ok: true, build: BUILD, version: VERSION, mode: "dev-mirror-off-by-default" });
  }

  // Tier-1 evidence anchor: pins this build to a commit so a transcript can assert the deployed
  // tree is the PR under review.
  if (req.method === "GET" && path === "/version") {
    return json({ build: BUILD, version: VERSION || "(unset)" });
  }

  // --- DEV-ONLY loopback endpoints (no consent, no credential, no storage) ---
  // Used ONLY when the page's "debug: mirror to sink" toggle is ON. They exist so the
  // acceptance ("mirror OFF ⇒ zero frame POSTs") can be shown both ways. A frame POSTed here
  // is counted and immediately discarded; a caption request returns a canned string. There is
  // no grant, no revocation, no trace — deliberately NOT the screenshare-debug sink pattern.
  if (req.method === "POST" && path === "/dev/echo") {
    const buf = new Uint8Array(await req.arrayBuffer());
    return json({ ok: true, dev: true, bytes: buf.length, ts: Date.now(), note: "loopback echo — frame discarded, nothing stored" });
  }
  if (req.method === "POST" && path === "/dev/caption") {
    const buf = new Uint8Array(await req.arrayBuffer());
    return json({ ok: true, dev: true, bytes: buf.length, caption: "a sample scene (dev echo — not a real caption)", ts: Date.now() });
  }

  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  Deno.serve({ port: 3000 }, (req) => handler(req, { env: Deno.env.toObject() }));
}
