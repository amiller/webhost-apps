// screenshare-debug — the screen-stream analogue of twitter-debug: a debug surface showing
// EXACTLY what a pod receives when a browser streams screen frames into it. The capture
// client is ported from tee-daemon/examples/screenshare-frames (getDisplayMedia →
// downsample → per-frame luma → JPEG); the sink stores the last N frames + metadata and
// echoes them back, so send-side and receive-side are comparable frame by frame.
//
// oauth3's role is identity only: the streamer signs in via window.oauth3.signIn and frames
// are tagged with the subject. No plugin, no grants — oauth3 is never in the frame data path.
// (The earlier consent-grant/capability build is preserved in NOTES-consent-demo.md.)

const BUILD = "b2";
const MAX_FRAMES = 60;

let ready = false;
let NODE = "https://pod.dstack.soc1024.com/oauth3";
let DATA_DIR = "./.data";

function initOnce(env: Record<string, string>, dataDir: string): void {
  if (ready) return;
  NODE = (env.OAUTH3_NODE || NODE).replace(/\/$/, "");
  DATA_DIR = dataDir || DATA_DIR;
  Deno.mkdirSync(DATA_DIR + "/frames", { recursive: true });
  ready = true;
}

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function readStatic(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`./public/${name}`, import.meta.url));
}

async function pruneFrames(): Promise<void> {
  const jpgs: string[] = [];
  for await (const e of Deno.readDir(DATA_DIR + "/frames")) if (e.name.endsWith(".jpg")) jpgs.push(e.name);
  if (jpgs.length <= MAX_FRAMES) return;
  jpgs.sort();
  for (const old of jpgs.slice(0, jpgs.length - MAX_FRAMES)) {
    await Deno.remove(`${DATA_DIR}/frames/${old}`).catch(() => {});
    await Deno.remove(`${DATA_DIR}/frames/${old.replace(/\.jpg$/, "")}.json`).catch(() => {});
  }
}

export default async function handler(req: Request, ctx: { env: Record<string, string>; dataDir: string }): Promise<Response> {
  initOnce(ctx.env || {}, ctx.dataDir || "");
  const path = new URL(req.url).pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(await readStatic("index.html"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  if (req.method === "GET" && path === "/health") {
    return json({ ok: true, build: BUILD, node: NODE });
  }

  // the sink: body = JPEG, x-luma header, x-subject = the signed-in oauth3 subject (identity
  // tag on the trace; the node can't yet verify tokens for third-party sinks — oauth3-server#121)
  if (req.method === "POST" && path === "/sink/frame") {
    const buf = new Uint8Array(await req.arrayBuffer());
    const luma = Number(req.headers.get("x-luma") || NaN);
    const sub = req.headers.get("x-subject") || "";
    const ts = Date.now();
    await Deno.writeFile(`${DATA_DIR}/frames/${ts}.jpg`, buf);
    await Deno.writeTextFile(`${DATA_DIR}/frames/${ts}.json`, JSON.stringify({ ts, bytes: buf.length, luma, sub }));
    await pruneFrames();
    return json({ ok: true, name: `${ts}.jpg`, bytes: buf.length, luma, serverTs: ts });
  }

  // echo list: what the pod received — the receive-side half of the debug view.
  if (req.method === "GET" && path === "/sink/frames") {
    const entries = [];
    for await (const e of Deno.readDir(DATA_DIR + "/frames")) {
      if (e.name.endsWith(".json")) entries.push(JSON.parse(await Deno.readTextFile(`${DATA_DIR}/frames/${e.name}`)));
    }
    entries.sort((a, b) => b.ts - a.ts);
    return json(entries);
  }

  if (req.method === "GET" && path.startsWith("/sink/frame/")) {
    const name = path.slice("/sink/frame/".length);
    if (!/^\d+\.jpg$/.test(name)) return new Response("bad name", { status: 400 });
    const body = await Deno.readFile(`${DATA_DIR}/frames/${name}`);
    return new Response(body, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  }

  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  const dataDir = "./.data";
  await Deno.mkdir(dataDir + "/frames", { recursive: true });
  Deno.serve({ port: 3000 }, (req) => handler(req, { env: Deno.env.toObject(), dataDir }));
}
