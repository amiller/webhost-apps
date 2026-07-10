// screenshare-debug (#51) — the OAuth3 direct-signing case study, now on RFC 0011 did:key UCAN.
// Builds on the swarm's #51 app but SWAPS the HMAC consent grant for a did:key UCAN capability
// (RFC 0011 / oauth3-server#86): the sink verifies the capability OFFLINE — cryptographically,
// anchored on the authority DID, no core call — instead of an HMAC the same app both signs and
// checks. Direct signing: oauth3 (here, the authority key) signs the consent; frames stream
// browser→sink DIRECT; oauth3 is never in the frame path. Keeps the echo-sink that proves
// delivery and the two-mode capture (real getDisplayMedia + a synthetic source for headless runs).
import { canInvoke, generateKeypair, type Keypair, mint } from "./ucan.ts";

const BUILD = "ucan-b1";
const MAX = 40;
let ready = false;
let authority: Keypair;
let SINK = "", STREAM = "", DATA_DIR = "./.data";
const revoked = new Set<string>(); // sink-side revocation (RFC 0011 app-layer): revoked UCAN strings
const frames: { seq: number; bytes: number; luma: number; ts: number }[] = [];
let latest: Uint8Array | null = null;
let acceptedN = 0, rejectedN = 0;

async function initOnce(dataDir: string) {
  if (ready) return;
  DATA_DIR = dataDir || DATA_DIR;
  authority = await generateKeypair(); // trust anchor for this instance
  SINK = authority.did;
  STREAM = `stream://${SINK}`;
  ready = true;
  console.log(`[screenshare-debug ${BUILD}] authority ${authority.did}`);
}

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const readStatic = (name: string) => Deno.readTextFile(new URL(`./public/${name}`, import.meta.url));

export default async function handler(req: Request, ctx: { env: Record<string, string>; dataDir: string }): Promise<Response> {
  await initOnce(ctx.dataDir || "");
  const path = new URL(req.url).pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(await readStatic("index.html"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (req.method === "GET" && path === "/health") return json({ ok: true, build: BUILD, authority: authority.did });
  if (req.method === "GET" && path === "/authority") return json({ did: authority.did, sink: SINK, with: STREAM });

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
    const body = new Uint8Array(await req.arrayBuffer());
    if (!g) { rejectedN++; return json({ ok: false, seq, reason: "no capability presented" }, 401); }
    if (revoked.has(g)) { rejectedN++; return json({ ok: false, seq, reason: "capability revoked" }, 401); }
    try {
      await canInvoke(g, { with: STREAM, can: "stream/frames", rate: 1, sink: SINK }, { root: authority.did });
    } catch (e) {
      rejectedN++;
      return json({ ok: false, seq, reason: (e as Error).message }, 401);
    }
    acceptedN++;
    latest = body.length ? body : latest;
    frames.push({ seq, bytes: body.length, luma, ts: Date.now() });
    if (frames.length > MAX) frames.shift();
    return json({ ok: true, seq, bytes: body.length });
  }

  if (req.method === "GET" && path === "/sink/frames") {
    return json({ accepted: acceptedN, rejected: rejectedN, last: frames.slice(-10).reverse() });
  }
  if (req.method === "GET" && path === "/sink/latest.jpg") {
    if (!latest) return new Response("no frame", { status: 404 });
    return new Response(latest as unknown as BodyInit, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  }
  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  await Deno.mkdir("./.data", { recursive: true }).catch(() => {});
  Deno.serve({ port: 3000 }, (req) => handler(req, { env: Deno.env.toObject(), dataDir: "./.data" }));
}
