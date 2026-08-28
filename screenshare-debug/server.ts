// screenshare-debug — opt-in debug-trace recorder sink (#70). The browser records a bounded
// frame trace locally, the user reviews it (delete frames, black out regions), and only then
// uploads it here as one session: frames + metadata grouped under a session id, with the
// "what were you doing?" note. Traces are ephemeral — an unkept session expires (TTL) unless
// the user explicitly keeps it. No identity, no grants, no tokens (#70 non-goals): the browser
// originating the upload is the control.

const BUILD = "trace-1";
const TTL_MS = 60 * 60 * 1000; // unkept sessions expire an hour after upload
const MAX_SESSIONS = 20;
const MOUNT = (Deno.env.get("MOUNT") || "/screenshare-debug").replace(/\/$/, "");
const SID_RE = /^s-[a-z0-9]{6,12}$/;

let DATA_DIR = "./data";
let ready = false;
function initOnce(dataDir: string): void {
  if (ready) return;
  DATA_DIR = dataDir || DATA_DIR;
  Deno.mkdirSync(DATA_DIR + "/sessions", { recursive: true });
  ready = true;
}

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (msg: string, s = 400) => json({ ok: false, error: msg }, s);
const sessDir = (sid: string) => `${DATA_DIR}/sessions/${sid}`;
const rel = (p: string) => (p.startsWith(MOUNT + "/") ? p.slice(MOUNT.length) : p);

async function readMeta(sid: string): Promise<{ sid: string; note: string; created: number; expiresAt: number | null; kept: boolean; frames: { seq: number; ts: number; bytes: number; luma: number }[] }> {
  return JSON.parse(await Deno.readTextFile(`${sessDir(sid)}/meta.json`));
}
async function writeMeta(sid: string, meta: unknown): Promise<void> {
  await Deno.writeTextFile(`${sessDir(sid)}/meta.json`, JSON.stringify(meta));
}
async function listSids(): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(DATA_DIR + "/sessions")) if (e.isDirectory) out.push(e.name);
  return out;
}

// drop expired unkept sessions and the oldest ones past MAX_SESSIONS
async function sweep(): Promise<void> {
  const sids = await listSids();
  const now = Date.now();
  const metas = [];
  for (const sid of sids) {
    try { metas.push(await readMeta(sid)); } catch (_) { /* half-written dir: drop below */ metas.push({ sid, created: 0, expiresAt: now, kept: false }); }
  }
  const dead = metas.filter((m) => !m.kept && (m.expiresAt ?? 0) < now).map((m) => m.sid);
  const unkept = metas.filter((m) => !m.kept && !((m.expiresAt ?? 0) < now)).sort((a, b) => a.created - b.created);
  while (unkept.length > MAX_SESSIONS) dead.push(unkept.shift()!.sid);
  for (const sid of [...new Set(dead)]) await Deno.remove(sessDir(sid), { recursive: true }).catch(() => {});
}

export default async function handler(req: Request, ctx: { env: Record<string, string>; dataDir: string }): Promise<Response> {
  initOnce(ctx.dataDir || "");
  const path = rel(new URL(req.url).pathname);
  await sweep();

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(await Deno.readTextFile(new URL("./public/index.html", import.meta.url)),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  if (req.method === "GET" && path === "/health") {
    return json({ ok: true, build: BUILD, mount: MOUNT, sessions: (await listSids()).length });
  }

  // create a session: {sid, note, frames:[{seq,ts,bytes,luma}]} — the review result, before any bytes land
  if (req.method === "POST" && path === "/sink/session") {
    const body = await req.json().catch(() => null);
    if (!body || !SID_RE.test(String(body.sid || ""))) return err("bad sid (want s-<6..12 alnum>)");
    if (!Array.isArray(body.frames) || body.frames.length === 0) return err("session needs >=1 frame");
    const sid = String(body.sid);
    try { await readMeta(sid); return err(`session ${sid} exists`, 409); } catch (_) { /* not there yet */ }
    await Deno.mkdir(sessDir(sid), { recursive: true });
    await writeMeta(sid, {
      sid,
      note: String(body.note || ""),
      created: Date.now(),
      expiresAt: Date.now() + TTL_MS,
      kept: false,
      frames: body.frames.map((f: { seq: number; ts: number; bytes: number; luma: number }, i: number) =>
        ({ seq: Number(f.seq) || i + 1, ts: Number(f.ts) || Date.now(), bytes: Number(f.bytes) || 0, luma: Number(f.luma) || 0 })),
    });
    return json({ ok: true, sid, expiresInSeconds: TTL_MS / 1000 });
  }

  // deliver one reviewed frame: JPEG bytes, blackout already applied browser-side pre-encode
  let m = path.match(/^\/sink\/frame\/(s-[a-z0-9]{6,12})\/(\d+)\.jpg$/);
  if (req.method === "POST" && m) {
    const [, sid, seq] = m;
    let meta;
    try { meta = await readMeta(sid); } catch (_) { return err(`no session ${sid}`, 404); }
    if (!meta.frames.some((f) => f.seq === Number(seq))) return err(`seq ${seq} not in session ${sid}`);
    const buf = new Uint8Array(await req.arrayBuffer());
    await Deno.writeFile(`${sessDir(sid)}/${seq}.jpg`, buf);
    const f = meta.frames.find((x) => x.seq === Number(seq))!;
    f.bytes = buf.length;
    f.luma = Number(req.headers.get("x-luma") || f.luma) || f.luma;
    await writeMeta(sid, meta);
    return json({ ok: true, sid, seq: Number(seq), bytes: buf.length });
  }

  m = path.match(/^\/sink\/frame\/(s-[a-z0-9]{6,12})\/(\d+)\.jpg$/);
  if (req.method === "GET" && m) {
    const [, sid, seq] = m;
    const body = await Deno.readFile(`${sessDir(sid)}/${seq}.jpg`).catch(() => null);
    if (!body) return err(`no frame ${sid}/${seq}`, 404);
    return new Response(body, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  }

  // dev side: session list with frames+note
  if (req.method === "GET" && path === "/sink/sessions") {
    const out = [];
    for (const sid of await listSids()) {
      try { out.push(await readMeta(sid)); } catch (_) { /* swept mid-list */ }
    }
    out.sort((a, b) => b.created - a.created);
    return json(out);
  }

  // flat frame listing — each entry carries its session id. Before upload this lists NOTHING
  // for the session: nothing has left the browser yet.
  if (req.method === "GET" && path === "/sink/frames") {
    const out = [];
    for (const sid of await listSids()) {
      try {
        const meta = await readMeta(sid);
        for (const f of meta.frames) {
          const has = await Deno.stat(`${sessDir(sid)}/${f.seq}.jpg`).then(() => true).catch(() => false);
          if (has) out.push({ sid, note: meta.note, kept: meta.kept, ...f });
        }
      } catch (_) { /* swept mid-list */ }
    }
    out.sort((a, b) => b.ts - a.ts);
    return json(out);
  }

  // explicit keep: the only way a trace outlives the TTL
  m = path.match(/^\/sink\/session\/(s-[a-z0-9]{6,12})\/keep$/);
  if (req.method === "POST" && m) {
    const sid = m[1];
    let meta;
    try { meta = await readMeta(sid); } catch (_) { return err(`no session ${sid}`, 404); }
    meta.kept = true;
    meta.expiresAt = null;
    await writeMeta(sid, meta);
    return json({ ok: true, sid, kept: true });
  }

  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  const dataDir = "./data";
  await Deno.mkdir(dataDir + "/sessions", { recursive: true });
  Deno.serve({ port: 8080 }, (req) => handler(req, { env: Deno.env.toObject(), dataDir }));
}
