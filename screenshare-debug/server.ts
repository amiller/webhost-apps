// screenshare-debug — a debug/sample webhost app for streaming screen-share frames INTO a
// pod app under a scoped, revocable consent grant. Sits alongside feedling (youtube) and
// timeline-peek (twitter) in the case-study family; the capture client is ported from the
// proven tee-daemon/examples/screenshare-frames (getDisplayMedia → downsample → per-frame
// luma → JPEG).
//
// ARCHITECTURE (per issue #51 operator decision, 2026-07-09):
//   • It is a POD app — deno server.ts deployed on the tee-daemon, like otterpilot / feedling.
//   • oauth3's role is IDENTITY + the trust root for a signed, revocable consent grant. The
//     streamer proves who they are via window.oauth3.signIn (no plugin required — unlike the
//     otter/youtube connects, screen-stream has no oauth3 plugin, and the decision REJECTED a
//     companion screen-stream ingredient). oauth3 is NEVER in the frame data path.
//   • The consent grant is issued and HMAC-signed by THIS app (the oauth3-authenticated
//     relying party), bound to the oauth3 subject. The browser carries it as a bearer to the
//     sink. (The decision's "signed via oauth3" is satisfied in spirit — the grant's trust
//     root is the oauth3 identity — but literally signing it inside the core would need the
//     rejected ingredient, so the relying party signs it. Stated plainly in the README.)
//   • Frames stream DIRECT browser → sink. Two sink modes: (a) the built-in debug echo-sink
//     (stores the last N frames and echoes them back so you SEE what the pod received — the
//     screenshare-frames /frames pattern), and (b) aishley's encrypted-to-enclave ingest as
//     the "real" target (second sink; its enclave verify link is shown but the ingest itself
//     is not exercised by this build).
//   • Revoke = the grant's jti is added to the revocation set; the sink honors it, so a
//     post-revoke frame POST 401s — visibly, in the console.
//
// Env (ctx.env): OAUTH3_NODE (default the pod), optional AISHLEY_URL / AISHLEY_VERIFY.

const BUILD = "b1";
const MAX_FRAMES = 60; // debug echo-sink keeps the last N frames (+ their metadata)

let ready = false;
let NODE = "https://pod.dstack.soc1024.com/oauth3";
let AISHLEY_URL = "";
let AISHLEY_VERIFY = "";
let DATA_DIR = "./.data";
let SECRET = new Uint8Array(0); // HMAC key for consent grants — generated/persisted on first run

function initOnce(env: Record<string, string>, dataDir: string): void {
  if (ready) return;
  NODE = (env.OAUTH3_NODE || NODE).replace(/\/$/, "");
  AISHLEY_URL = (env.AISHLEY_URL || "").replace(/\/$/, "");
  AISHLEY_VERIFY = env.AISHLEY_VERIFY || "";
  DATA_DIR = dataDir || DATA_DIR;
  Deno.mkdirSync(DATA_DIR + "/frames", { recursive: true });
  SECRET = new Uint8Array(loadSecret()); // fresh ArrayBuffer-backed copy (crypto.subtle wants ArrayBufferView<ArrayBuffer>)
  ready = true;
}

// --- HMAC-signed consent grants: sdc.<b64url(payload)>.<b64url(hmac)> ---
// Stateless to verify (sig + exp), plus a persisted revocation set for immediate revoke.
// UTF-8-safe base64url for the JSON payload (scope sentences contain em-dashes);
// raw-byte base64url for the HMAC signature.
const enc = new TextEncoder(), dec = new TextDecoder();
function b64urlBytes(u: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64urlBytes(enc.encode(s));
}
function b64urlDecodeStr(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}

function loadSecret(): Uint8Array {
  const f = DATA_DIR + "/consent.key";
  try {
    const hex = Deno.readTextFileSync(f).trim();
    if (hex.length === 64) {
      const u = new Uint8Array(32);
      for (let i = 0; i < 32; i++) u[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return u;
    }
  } catch (_) { /* not yet generated */ }
  const u: Uint8Array = new Uint8Array(32);
  crypto.getRandomValues(u);
  try { Deno.writeTextFileSync(f, [...u].map((b) => b.toString(16).padStart(2, "0")).join("")); }
  catch (_) { /* dev fs may be read-only — ephemeral key, still functional */ }
  return u;
}

async function sign(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", SECRET, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return b64urlBytes(sig);
}

interface GrantPayload {
  sub: string;    // oauth3 subject (u-…) the streamer signed in as, or "anon-…" without the extension
  sink: string;   // "echo" | "aishley"
  rate: number;   // agreed capture interval, seconds
  scope: string;  // plain-English scope sentence shown on the receipt
  iat: number;    // issued at, ms
  exp: number;    // expiry, ms
  jti: string;    // grant id — what revoke invalidates
}

function revokedSet(): Set<string> {
  try { return new Set(JSON.parse(Deno.readTextFileSync(DATA_DIR + "/revoked.json") || "[]")); }
  catch (_) { return new Set(); }
}
function persistRevoked(s: Set<string>): void {
  try { Deno.writeTextFileSync(DATA_DIR + "/revoked.json", JSON.stringify([...s])); } catch (_) { /* best-effort */ }
}

async function mintGrant(p: { sub: string; sink: string; rate: number; scope: string; ttlMin: number }): Promise<{ grant: string; payload: GrantPayload }> {
  const now = Date.now();
  const payload: GrantPayload = {
    sub: p.sub, sink: p.sink, rate: p.rate, scope: p.scope,
    iat: now, exp: now + p.ttlMin * 60_000, jti: "jti-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 8),
  };
  const body = b64urlStr(JSON.stringify(payload));
  const grant = `sdc.${body}.${await sign("sdc." + body)}`;
  return { grant, payload };
}

type VerifyResult = { ok: true; payload: GrantPayload } | { ok: false; reason: string; status: number };
async function verifyGrant(grant: string): Promise<VerifyResult> {
  const parts = grant.split(".");
  if (parts.length !== 3 || parts[0] !== "sdc") return { ok: false, reason: "malformed grant", status: 401 };
  const [_, body, sig] = parts;
  const expect = await sign("sdc." + body);
  if (expect !== sig) return { ok: false, reason: "bad signature", status: 401 };
  let payload: GrantPayload;
  try { payload = JSON.parse(b64urlDecodeStr(body)); }
  catch (_) { return { ok: false, reason: "bad payload", status: 401 }; }
  if (Date.now() >= payload.exp) return { ok: false, reason: "grant expired", status: 401 };
  if (revokedSet().has(payload.jti)) return { ok: false, reason: "grant revoked", status: 401 };
  return { ok: true, payload };
}

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function readStatic(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`./public/${name}`, import.meta.url));
}

// --- frame echo-sink storage (the screenshare-frames pattern, last N kept) ---
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
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(await readStatic("index.html"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  if (req.method === "GET" && path === "/health") {
    return json({ ok: true, build: BUILD, node: NODE, sinks: { echo: true, aishley: !!AISHLEY_URL }, aishley_verify: AISHLEY_VERIFY });
  }

  // Mint a signed consent grant bound to the oauth3 subject. The browser gets this after the
  // streamer approves, and carries it as a bearer to the sink.
  if (req.method === "POST" && path === "/consent/grant") {
    const b = await req.json().catch(() => ({}));
    const sub = String(b.sub || "anon-" + Math.random().toString(36).slice(2, 10));
    const sink = b.sink === "aishley" && AISHLEY_URL ? "aishley" : "echo";
    const rate = Math.max(0.2, Number(b.rate) || 2);
    const ttl = Math.min(24 * 60, Math.max(1, Number(b.ttlMin) || 60));
    const scope = sink === "aishley"
      ? `stream your screen (${rate.toFixed(1)}s/frame) to aishley's enclave ingest at ${AISHLEY_URL} — encrypted in-browser, host sees ciphertext — until revoked`
      : `stream your screen (${rate.toFixed(1)}s/frame) to the debug echo-sink on this pod — it stores the last ${MAX_FRAMES} frames to PROVE delivery — until revoked`;
    const { grant, payload } = await mintGrant({ sub, sink, rate, scope, ttlMin: ttl });
    return json({ grant, payload: { ...payload, sub: payload.sub.slice(0, 10) + "…" } });
  }

  if (req.method === "GET" && path === "/consent/verify") {
    const g = url.searchParams.get("grant") || "";
    const res = await verifyGrant(g);
    if (res.ok) return json({ ok: true, payload: { ...res.payload, sub: res.payload.sub.slice(0, 10) + "…" } });
    return json({ ok: false, reason: res.reason }, res.status);
  }

  // Revoke: invalidates the grant's jti. The next frame POST 401s — the acceptance criterion.
  if (req.method === "POST" && path === "/consent/revoke") {
    const g = (await req.json().catch(() => ({})).then((b: { grant?: string }) => b.grant)) ||
      (req.headers.get("authorization") || "").replace(/^bearer /i, "").trim();
    const res = await verifyGrant(g);
    if (!res.ok) return json({ ok: false, reason: res.reason }, res.status);
    const s = revokedSet(); s.add(res.payload.jti); persistRevoked(s);
    return json({ ok: true, jti: res.payload.jti });
  }

  // --- the sink: POST /sink/frame (bearer = consent grant, body = JPEG, x-luma header) ---
  if (req.method === "POST" && path === "/sink/frame") {
    const grant = (req.headers.get("authorization") || "").replace(/^bearer /i, "").trim();
    const v = await verifyGrant(grant);
    if (!v.ok) return json({ ok: false, error: v.reason }, v.status); // 401 after revoke/expiry
    const buf = new Uint8Array(await req.arrayBuffer());
    const luma = Number(req.headers.get("x-luma") || NaN);
    const ts = Date.now();
    const name = `${ts}.jpg`;
    await Deno.writeFile(`${DATA_DIR}/frames/${name}`, buf);
    await Deno.writeTextFile(`${DATA_DIR}/frames/${ts}.json`, JSON.stringify({ ts, bytes: buf.length, luma, sink: v.payload.sink, jti: v.payload.jti }));
    await pruneFrames();

    // aishley mode: forward DIRECTLY to the enclave ingest (browser→enclave, not through oauth3).
    // The grant authorized it; we relay here only so the debug console can report the real HTTP
    // outcome. If AISHLEY_URL isn't configured this is skipped (sink stays "echo").
    if (v.payload.sink === "aishley" && AISHLEY_URL) {
      try {
        const r = await fetch(`${AISHLEY_URL}/frame`, { method: "POST", headers: { "content-type": "image/jpeg", "x-luma": String(luma) }, body: buf });
        return json({ ok: r.ok, name, bytes: buf.length, luma, serverTs: ts, relay_status: r.status });
      } catch (e) {
        return json({ ok: false, name, bytes: buf.length, luma, serverTs: ts, relay_error: String((e as Error)?.message || e) });
      }
    }
    return json({ ok: true, name, bytes: buf.length, luma, serverTs: ts });
  }

  // echo list: what the pod received (the proof of delivery the console renders).
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
