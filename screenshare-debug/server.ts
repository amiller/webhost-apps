// screenshare-debug (#51 base, #71 change detection) — the OAuth3 direct-signing case study on
// RFC 0011 did:key UCAN, extended with cheap pixel-change signals so a visual model is rarely
// needed but can be invoked on demand. Direct signing: oauth3 (the authority key) signs the
// consent; frames stream browser→sink DIRECT; oauth3 is never in the frame path. Keeps the
// echo-sink that proves delivery and the two-mode capture (real getDisplayMedia + a synthetic
// source for headless runs).
//
// #71 adds: per-frame change accounting (still/local/scene classes), delta-aware sending
// (still→heartbeat skip), hi-res keyframes on demand (POST /sink/keyframe at a requested width),
// and OPTIONAL server-side OCR (OCR_CMD) / visual-model (VLM_URL) hooks that are absent-by-
// default and degrade to an explicit "not configured" — never silent, never a fallback.
import { canInvoke, generateKeypair, type Keypair, mint } from "./ucan.ts";

const BUILD = "change-detect-1";
const MAX = 40;
let ready = false;
let authority: Keypair;
let SINK = "", STREAM = "", DATA_DIR = "./.data";
const revoked = new Set<string>(); // sink-side revocation (RFC 0011 app-layer): revoked UCAN strings
const frames: { seq: number; bytes: number; luma: number; scene?: boolean; ts: number }[] = [];
let latest: Uint8Array | null = null;
let acceptedN = 0, rejectedN = 0;
// #71 change-detect counters + keyframe state
let stillN = 0, sceneN = 0, modelCalls = 0;
let wantKeyframe: number | null = null; // server-side pending hi-res request, surfaced in /sink/frame
let latestKeyframe: { bytes: number; width: number; height: number; ocr?: string; vlm?: string; ts: number } | null = null;
let latestKeyframeJpg: Uint8Array | null = null;

// Optional server-side hooks (absent by default → "not configured", never a fallback)
let OCR_CMD = "", VLM_URL = "";

async function initOnce(dataDir: string, env: Record<string, string> = {}) {
  if (ready) return;
  DATA_DIR = dataDir || DATA_DIR;
  authority = await generateKeypair(); // trust anchor for this instance
  SINK = authority.did;
  STREAM = `stream://${SINK}`;
  OCR_CMD = (env.OCR_CMD || Deno.env.get("OCR_CMD") || "").trim();
  VLM_URL = (env.VLM_URL || Deno.env.get("VLM_URL") || "").trim();
  ready = true;
  console.log(`[screenshare-debug ${BUILD}] authority ${authority.did} · OCR_CMD ${OCR_CMD ? "set" : "unset"} · VLM_URL ${VLM_URL ? "set" : "unset"}`);
}

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const readStatic = (name: string) => Deno.readTextFile(new URL(`./public/${name}`, import.meta.url));

// Verify a presented UCAN capability for the stream/frames capability. Throws on failure.
async function verifyGrant(g: string): Promise<void> {
  if (!g) throw new Error("no capability presented");
  if (revoked.has(g)) throw new Error("capability revoked");
  await canInvoke(g, { with: STREAM, can: "stream/frames", rate: 1, sink: SINK }, { root: authority.did });
}

// OPTIONAL OCR hook: run OCR_CMD <tmpfile> and return its stdout. Only called when OCR_CMD is set.
async function runOcr(jpeg: Uint8Array): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!OCR_CMD) return { ok: false, error: "OCR_CMD not configured" };
  const tmp = await Deno.makeTempFile({ suffix: ".jpg" });
  try {
    await Deno.writeFile(tmp, jpeg);
    const parts = OCR_CMD.split(/\s+/).filter(Boolean);
    const cmd = new Deno.Command(parts[0], { args: [...parts.slice(1), tmp], stdout: "piped", stderr: "piped" });
    const out = await cmd.output();
    const text = new TextDecoder().decode(out.stdout).trim();
    if (!out.success) return { ok: false, error: `OCR_CMD exit ${out.code}: ${new TextDecoder().decode(out.stderr).trim()}` };
    return { ok: true, text: text || "(empty)" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

// OPTIONAL VLM hook: POST the jpeg to VLM_URL, expect {text}|{caption}|raw text back.
async function runVlm(jpeg: Uint8Array): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!VLM_URL) return { ok: false, error: "VLM_URL not configured" };
  modelCalls++;
  try {
    const r = await fetch(VLM_URL, { method: "POST", headers: { "content-type": "image/jpeg" }, body: jpeg as unknown as BodyInit });
    const ct = r.headers.get("content-type") || "";
    let text: string;
    if (ct.includes("json")) {
      const j = await r.json();
      text = String(j.text || j.caption || j.description || JSON.stringify(j));
    } else {
      text = (await r.text()).trim();
    }
    if (!r.ok) return { ok: false, error: `VLM_URL HTTP ${r.status}: ${text.slice(0, 120)}` };
    return { ok: true, text: text || "(empty)" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export default async function handler(req: Request, ctx: { env: Record<string, string>; dataDir: string }): Promise<Response> {
  await initOnce(ctx.dataDir || "", ctx.env || {});
  const path = new URL(req.url).pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(await readStatic("index.html"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (req.method === "GET" && path === "/health") return json({ ok: true, build: BUILD, authority: authority.did });
  if (req.method === "GET" && path === "/authority") return json({ did: authority.did, sink: SINK, with: STREAM });

  // #71: expose hook configuration so the UI can render "not configured" honestly.
  if (req.method === "GET" && path === "/config") {
    return json({ build: BUILD, ocr: { configured: !!OCR_CMD, cmd: OCR_CMD || null }, vlm: { configured: !!VLM_URL, url: VLM_URL || null } });
  }

  // AUTHORITY: sign a scoped consent capability (a did:key UCAN) for the streamer's session DID.
  if (req.method === "POST" && path === "/consent/grant") {
    const b = await req.json().catch(() => ({})) as { sessionDid?: string; rate?: number; ttlMin?: number };
    if (!b.sessionDid?.startsWith("did:key:")) return json({ error: "sessionDid (did:key) required" }, 400);
    const maxRate = Math.min(30, Math.max(0.1, Number(b.rate) || 4));
    const seconds = Math.min(24 * 3600, Math.max(5, (Number(b.ttlMin) || 30) * 60));
    const now = Math.floor(Date.now() / 1000);
    const grant = await mint({
      issuer: authority,
      audience: b.sessionDid,
      capabilities: [{ with: STREAM, can: "stream/frames", nb: { maxRate, until: now + seconds, sink: SINK } }],
      expiresInSec: seconds,
    });
    return json({ grant, sink: SINK, with: STREAM, maxRate, expiresInSec: seconds });
  }

  // Revoke: the presented capability stops working immediately at the sink.
  if (req.method === "POST" && path === "/consent/revoke") {
    const b = await req.json().catch(() => ({})) as { grant?: string };
    const g = b.grant || (req.headers.get("authorization") || "").replace(/^bearer /i, "").trim();
    if (!g) return json({ error: "no capability" }, 400);
    revoked.add(g);
    return json({ revoked: true });
  }

  // SINK: verify the capability OFFLINE, then accept or reject the frame.
  if (req.method === "POST" && path === "/sink/frame") {
    const g = (req.headers.get("authorization") || "").replace(/^bearer /i, "").trim();
    const seq = Number(req.headers.get("x-seq") || "0");
    const luma = Number(req.headers.get("x-luma") || "0");
    const scene = req.headers.has("x-scene");
    const body = new Uint8Array(await req.arrayBuffer());
    try {
      await verifyGrant(g);
    } catch (e) {
      rejectedN++;
      return json({ ok: false, seq, reason: (e as Error).message }, 401);
    }
    acceptedN++;
    if (scene) sceneN++;
    latest = body.length ? body : latest;
    frames.push({ seq, bytes: body.length, luma, scene, ts: Date.now() });
    if (frames.length > MAX) frames.shift();
    // Surface a pending server-side hi-res keyframe request, then clear it (one-shot).
    const kf = wantKeyframe;
    wantKeyframe = null;
    return json({ ok: true, seq, bytes: body.length, scene, wantKeyframe: kf });
  }

  // #71: still frames skip the image POST entirely; this heartbeat keeps sink-side accounting
  // honest so "accepted" only rises on real frame bytes (the acceptance proof).
  if (req.method === "POST" && path === "/sink/heartbeat") {
    const g = (req.headers.get("authorization") || "").replace(/^bearer /i, "").trim();
    try {
      await verifyGrant(g);
    } catch (e) {
      return json({ ok: false, reason: (e as Error).message }, 401);
    }
    stillN++;
    const kf = wantKeyframe;
    wantKeyframe = null;
    return json({ ok: true, still: true, wantKeyframe: kf });
  }

  // #71: server-side pending hi-res request — a remote consumer can ask for a big frame, and the
  // next frame/heartbeat response carries {wantKeyframe: <width>} so the client fulfills it once.
  if (req.method === "POST" && path === "/sink/want-keyframe") {
    const b = await req.json().catch(() => ({})) as { width?: number };
    const w = Math.min(3840, Math.max(160, Number(b.width) || 1280));
    wantKeyframe = w;
    return json({ ok: true, wantKeyframe: w });
  }

  // #71: hi-res keyframe on demand — client re-draws the full-res video frame at the requested
  // width and POSTs it once. Optional OCR/VLM hooks run here; absent → explicit "not configured".
  if (req.method === "POST" && path === "/sink/keyframe") {
    const g = (req.headers.get("authorization") || "").replace(/^bearer /i, "").trim();
    const width = Number(req.headers.get("x-width") || "0");
    const height = Number(req.headers.get("x-height") || "0");
    const want = (req.headers.get("x-want") || "").toLowerCase(); // "" | "ocr" | "vlm"
    const jpeg = new Uint8Array(await req.arrayBuffer());
    try {
      await verifyGrant(g);
    } catch (e) {
      return json({ ok: false, reason: (e as Error).message }, 401);
    }
    let ocr: { ok: boolean; text?: string; error?: string } | undefined;
    let vlm: { ok: boolean; text?: string; error?: string } | undefined;
    // OCR runs on every keyframe when configured (cheap-ish, and it's the OCR hook's purpose);
    // VLM runs only when explicitly requested (it's the expensive call we want to show is RARE).
    if (OCR_CMD) ocr = await runOcr(jpeg);
    if (want === "vlm") vlm = await runVlm(jpeg);
    latestKeyframe = { bytes: jpeg.length, width, height, ocr: ocr?.text, vlm: vlm?.text, ts: Date.now() };
    latestKeyframeJpg = jpeg;
    return json({
      ok: true, bytes: jpeg.length, width, height,
      ocr: ocr ?? { ok: false, error: "OCR_CMD not configured" },
      vlm: vlm ?? { ok: false, error: "VLM_URL not configured" },
      configured: { ocr: !!OCR_CMD, vlm: !!VLM_URL },
    });
  }

  if (req.method === "GET" && path === "/sink/keyframe") {
    return json(latestKeyframe ? { ...latestKeyframe, configured: { ocr: !!OCR_CMD, vlm: !!VLM_URL } } : { ok: false, reason: "no keyframe yet", configured: { ocr: !!OCR_CMD, vlm: !!VLM_URL } });
  }
  if (req.method === "GET" && path === "/sink/keyframe.jpg") {
    if (!latestKeyframeJpg) return new Response("no keyframe", { status: 404 });
    return new Response(latestKeyframeJpg as unknown as BodyInit, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  }

  if (req.method === "GET" && path === "/sink/frames") {
    return json({
      accepted: acceptedN, rejected: rejectedN,
      still: stillN, scene: sceneN, modelCalls,
      keyframe: latestKeyframe,
      configured: { ocr: !!OCR_CMD, vlm: !!VLM_URL },
      last: frames.slice(-10).reverse(),
    });
  }
  if (req.method === "GET" && path === "/sink/latest.jpg") {
    if (!latest) return new Response("no frame", { status: 404 });
    return new Response(latest as unknown as BodyInit, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  }
  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  await Deno.mkdir("./.data", { recursive: true }).catch(() => {});
  const port = Number(Deno.env.get("PORT") || "3000");
  Deno.serve({ port, hostname: "0.0.0.0" }, (req) => handler(req, { env: Deno.env.toObject(), dataDir: "./.data" }));
}
