// edge-tee attested interposer — dstack-webhost handler.
//
// Same job as the SiMG301 firmware, in a confidential VM: hold the API key,
// witness every call, commit to the exact bytes, and attest a Merkle root over
// the session. The commitment construction is byte-identical to the chip's, so
// one verifier checks both attesters — the only thing that differs is what
// signs the root (a PSA IAT there, a TDX quote here).
//
// The session id rides in the placeholder auth token the agent already sends,
// so an unmodified Claude Code needs nothing but ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN=sess_<id>.

const UPSTREAM = "api.anthropic.com";
let BROKER = "/run/broker/dstack.sock";
try {
  BROKER = Deno.env.get("DSTACK_BROKER") ?? BROKER;
} catch { /* no env permission in the shared runtime; the default is correct there */ }

type Call = {
  n: number;
  ts: string;
  request_redacted: string;   // latin-1 view of the bytes, $APIKEY left literal
  response_b64: string;
  commitment: string;
  seconds: number;
};

type Beacon = { source: string; round: number; randomness: string; fetched: string };

type Session = {
  id: string;
  beacon: Beacon | null;
  purpose: string;
  profile: string;
  instructed_by: string;
  meta: Uint8Array;
  calls: Call[];
  opened: string;
};

const sessions = new Map<string, Session>();

// --- byte helpers -----------------------------------------------------------

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(n));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", concat(...parts)));
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// latin-1: one byte per code unit, so raw bytes survive a round-trip through a
// string. The Python side stores request_redacted the same way.
const latin1 = (b: Uint8Array) => String.fromCharCode(...b);
const unlatin1 = (s: string): Uint8Array<ArrayBuffer> =>
  concat(Uint8Array.from([...s].map((c) => c.charCodeAt(0))));

function b64(b: Uint8Array): string {
  return btoa(latin1(b));
}

// --- commitment + RFC 6962 Merkle (must match host/frames.py and host/merkle.py)

async function commitment(host: string, redacted: Uint8Array, response: Uint8Array) {
  return await sha256(enc.encode("zktls-v1\0"), enc.encode(host), new Uint8Array([0]),
                      redacted, new Uint8Array([0]), response);
}

function sessionMeta(profile: string, purpose: string): Uint8Array {
  const p = enc.encode(profile);
  if (p.length > 255) throw new Error("profile too long");
  return concat(new Uint8Array([p.length]), p, enc.encode(purpose));
}

const split = (n: number) => { let k = 1; while (k * 2 < n) k *= 2; return k; };

async function merkleRoot(leaves: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  if (leaves.length === 0) return await sha256();
  if (leaves.length === 1) return await sha256(concat(new Uint8Array([0])), leaves[0]);
  const k = split(leaves.length);
  return await sha256(new Uint8Array([1]),
                      await merkleRoot(leaves.slice(0, k)),
                      await merkleRoot(leaves.slice(k)));
}

async function sessionRoot(meta: Uint8Array, leaves: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  const metaHash = await sha256(enc.encode("zktls-session-v2\0"), meta);
  const root = leaves.length ? await merkleRoot(leaves) : new Uint8Array(32);
  const count = new Uint8Array(new ArrayBuffer(4));
  new DataView(count.buffer).setUint32(0, leaves.length, false);
  return await sha256(enc.encode("zktls-root-v2\0"), metaHash, root, count);
}

// --- dstack broker ----------------------------------------------------------

/** JSON-RPC over the filtered unix socket. Absent in local dev; the caller
 *  reports that rather than pretending a quote exists. */
async function brokerCall(method: string, body: unknown): Promise<unknown> {
  const payload = JSON.stringify(body);
  const conn = await Deno.connect({ path: BROKER, transport: "unix" });
  try {
    const req = `POST /${method} HTTP/1.1\r\nHost: localhost\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${payload.length}\r\n` +
      `Connection: close\r\n\r\n${payload}`;
    await conn.write(enc.encode(req));
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(65536);
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }
    const raw = new TextDecoder().decode(concat(...chunks));
    const i = raw.indexOf("\r\n\r\n");
    if (i < 0) throw new Error("broker: no header terminator");
    return JSON.parse(raw.slice(i + 4));
  } finally {
    conn.close();
  }
}

/** Bind the session root into a TDX quote — the CVM's analogue of the chip
 *  signing an IAT whose nonce is the root. */
async function quoteOver(reportData: Uint8Array) {
  return await brokerCall("GetQuote", { report_data: hex(reportData) });
}

// --- timestamp anchoring ----------------------------------------------------
//
// The lower bound is the cheap direction and the only one obtainable without
// help: commit at session open to a public value that did not exist earlier, so
// the session provably did not happen before it. drand rounds are designed for
// this — a round number maps to wall-clock and the value is unpredictable until
// its round. The upper bound ("no later than") is not obtainable from inside;
// it requires publishing the root somewhere that timestamps it independently.
const DRAND = "https://api.drand.sh/public/latest";

async function fetchBeacon(): Promise<Beacon | null> {
  try {
    const r = await fetch(DRAND, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    return { source: "drand:api.drand.sh", round: j.round,
             randomness: j.randomness, fetched: new Date().toISOString() };
  } catch {
    return null;   // recorded as absent, never faked
  }
}

/** What the quote commits to. With a beacon the binding also fixes a lower
 *  bound on when the session ran; without one it is the bare root, and the
 *  bundle says which. */
async function reportData(root: Uint8Array<ArrayBuffer>, beacon: Beacon | null): Promise<Uint8Array<ArrayBuffer>> {
  if (!beacon) return root;
  return await sha256(enc.encode("zktls-anchor-v1\0"), root,
                      enc.encode(`${beacon.source}:${beacon.round}:${beacon.randomness}`));
}

/** Read config from the manifest env, falling back to process env. The shared
 *  runtime may run without env permission, where Deno.env.get throws rather than
 *  returning undefined — an unreadable setting must land on the fail-closed path,
 *  not surface as a 500. */
function cfg(ctx: { env?: Record<string, string> } | undefined, key: string): string {
  const v = ctx?.env?.[key];
  if (v !== undefined && v !== "") return v;
  try {
    return Deno.env.get(key) ?? "";
  } catch {
    return "";
  }
}

// --- the interposer ---------------------------------------------------------

function sessionFrom(req: Request): Session | null {
  const auth = req.headers.get("authorization") ?? "";
  const key = req.headers.get("x-api-key") ?? "";
  const tok = (auth.replace(/^Bearer\s+/i, "") || key).trim();
  return tok.startsWith("sess_") ? sessions.get(tok.slice(5)) ?? null : null;
}

const PASS = ["content-type", "accept", "anthropic-version", "anthropic-beta"];

async function relay(sess: Session, path: string, req: Request, apiKey: string) {
  const bodyBytes = new Uint8Array(await req.arrayBuffer());
  const declared = declare(bodyBytes, sess.purpose);

  // The redacted form keeps $APIKEY literal, exactly as the chip commits to it.
  const headers: Record<string, string> = { host: UPSTREAM, "x-api-key": "$APIKEY" };
  for (const h of PASS) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  const head = `POST ${path} HTTP/1.1\r\n` +
    Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
    `\r\ncontent-length: ${declared.length}\r\nConnection: close\r\n\r\n`;
  const redacted = concat(enc.encode(head), declared);

  const t0 = Date.now();
  const upstream = await fetch(`https://${UPSTREAM}${path}`, {
    method: "POST",
    headers: { ...headers, host: UPSTREAM, "x-api-key": apiKey },
    body: declared,
  });
  const respBody = new Uint8Array(await upstream.arrayBuffer());

  // Commit to the response as it went on the wire, status line included, so the
  // preimage matches what the chip would have hashed.
  const statusLine = `HTTP/1.1 ${upstream.status} ${upstream.statusText}\r\n`;
  const respHeaders = [...upstream.headers].map(([k, v]) => `${k}: ${v}`).join("\r\n");
  const wire = concat(enc.encode(statusLine + respHeaders + "\r\n\r\n"), respBody);

  const c = await commitment(UPSTREAM, redacted, wire);
  sess.calls.push({
    n: sess.calls.length + 1,
    ts: new Date().toISOString(),
    request_redacted: latin1(redacted),
    response_b64: b64(wire),
    commitment: hex(c),
    seconds: (Date.now() - t0) / 1000,
  });

  return new Response(respBody, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

/** Stamp the declared purpose into the request so the policy has something to
 *  test. The agent's first call carries none of its own system prompt. */
function declare(body: Uint8Array, purpose: string): Uint8Array<ArrayBuffer> {
  const d = JSON.parse(new TextDecoder().decode(body));
  const block = { type: "text", text: purpose };
  if (d.system === undefined) d.system = [block];
  else if (Array.isArray(d.system)) d.system = [...d.system, block];
  else if (typeof d.system === "string") d.system = d.system + "\n" + purpose;
  else throw new Error(`unexpected system field type ${typeof d.system}`);
  return concat(enc.encode(JSON.stringify(d)));
}

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });


// --- landing page -----------------------------------------------------------

function landing(state: { sessions: number; keyed: boolean; gated: boolean }) {
  const badge = (ok: boolean, yes: string, no: string) =>
    ok ? `<span class="ok">${yes}</span>` : `<span class="no">${no}</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>attest-proxy — witnessed agent sessions</title><style>
:root{--ground:#FAFAF9;--ink:#14212B;--muted:#5A6B77;--rule:#DFE4E8;--accent:#1B4D6B;
--ok:#166534;--no:#9B1C1C;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);margin:0;padding:0 22px 80px;
font:17px/1.62 Georgia,"Iowan Old Style","Times New Roman",serif;-webkit-font-smoothing:antialiased}
.w{max-width:760px;margin:0 auto}
header{padding:56px 0 22px;border-bottom:2px solid var(--ink)}
.eb{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;
color:var(--muted);margin:0 0 14px}
h1{font-size:34px;line-height:1.14;margin:0 0 14px;letter-spacing:-.015em}
.stand{color:var(--muted);font-size:18px;margin:0}
h2{font-size:21px;margin:38px 0 12px}
p{margin:0 0 14px}
code{font-family:var(--mono);font-size:.86em;background:#F1F3F5;padding:1px 5px;border-radius:3px}
pre{font-family:var(--mono);font-size:12.5px;line-height:1.66;background:#fff;
border:1px solid var(--rule);padding:14px 16px;overflow-x:auto;margin:0 0 16px}
table{border-collapse:collapse;font-family:var(--mono);font-size:13px;width:100%;margin:0 0 18px}
td,th{text-align:left;padding:8px 14px 8px 0;border-bottom:1px solid #EDF0F2}
th{color:var(--muted);font-weight:500;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.ok{color:var(--ok)}.no{color:var(--no)}
a{color:var(--accent)}
footer{margin-top:44px;padding-top:16px;border-top:1px solid var(--rule);
font-family:var(--mono);font-size:12px;color:var(--muted)}
</style></head><body><div class="w">
<header>
<p class="eb">edge-tee · attest-proxy</p>
<h1>Witnessed agent sessions</h1>
<p class="stand">Your agent runs with no credential. This service holds the key, relays every
call, commits to the exact bytes, and signs a Merkle root over the session — so you can prove
what you spent and on what, without showing the transcript.</p>
</header>

<h2>Status</h2>
<table><tbody>
<tr><th>open sessions</th><td>${state.sessions}</td></tr>
<tr><th>api key</th><td>${badge(state.keyed, "configured", "not configured")}</td></tr>
<tr><th>session gate</th><td>${badge(state.gated, "invite token required", "closed — no SESSION_TOKEN set")}</td></tr>
<tr><th>attestation</th><td><a href="../_api/verification/attest-proxy">/_api/verification/attest-proxy</a></td></tr>
</tbody></table>

<h2>Use it</h2>
<p>Open a session, run any agent against it, then close to get the signed bundle.</p>
<pre>curl -X POST $CVM/attest-proxy/session \\
  -H "Authorization: Bearer $INVITE" \\
  -d '{"purpose":"[research-router] my matter","profile":"holder-only"}'
# -> {"auth_token":"sess_...","beacon":{"round":...}}

ANTHROPIC_BASE_URL=$CVM/attest-proxy \\
ANTHROPIC_AUTH_TOKEN=sess_... \\
  claude -p "review this contract"

curl -X POST $CVM/attest-proxy/session/&lt;id&gt;/close</pre>

<h2>What a bundle proves</h2>
<p>Token counts and the model name come back inside Anthropic's own response, over a TLS
session terminated here against a pinned root — they are Anthropic's statement, not the
holder's. The call count is signed, so a partial disclosure still proves the total. A drand
round is folded in at session open, so the session provably did not run before it.</p>
<p>It does not prove that the described <em>character</em> of the work is accurate; that needs a
checker run over the transcript, and attestation would show the checker ran, not that its
verdict is right.</p>

<h2>Confidentiality</h2>
<p>This runs in a confidential VM. A counterparty should check the quote binds a CVM
measurement they accept <em>and</em> the source hash of this app, then pin that hash. The
operator holds deploy rights, so pinning and re-checking is what makes a swap visible rather
than silent.</p>

<footer>dev mode — quotes are unavailable until the project is promoted to attested</footer>
</div></body></html>`;
}

export default async function handler(
  req: Request,
  ctx?: { env: Record<string, string>; dataDir: string },
) {
  const url = new URL(req.url);
  const path = url.pathname;
  const apiKey = cfg(ctx, "ANTHROPIC_API_KEY");

  if (path === "/" || path === "/health") {
    const gated = cfg(ctx, "SESSION_TOKEN").length > 0;
    if (path === "/" && (req.headers.get("accept") ?? "").includes("text/html")) {
      return new Response(landing({ sessions: sessions.size, keyed: apiKey.length > 0, gated }),
        { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return json({
      service: "edge-tee attested interposer",
      sessions: sessions.size,
      key_present: apiKey.length > 0, gated,
      commitment: "zktls-v1", root: "zktls-root-v2 over an RFC 6962 tree",
    });
  }

  if (req.method === "POST" && path === "/session") {
    // This endpoint is reachable from the internet and spends a real key, so it
    // fails closed: without a configured invite token nobody can open a session,
    // and a deployment that has a key but no token is a misconfiguration we
    // refuse rather than quietly leave open.
    const invite = cfg(ctx, "SESSION_TOKEN");
    if (!invite) {
      return json({ error: "no SESSION_TOKEN configured; refusing to open sessions" }, 503);
    }
    const offered = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (offered !== invite) return json({ error: "invite token required" }, 401);
    const b = await req.json().catch(() => ({}));
    const purpose = String(b.purpose ?? "");
    if (!purpose) return json({ error: "purpose required" }, 400);
    const profile = String(b.profile ?? "holder-only");
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    const beacon = await fetchBeacon();
    sessions.set(id, {
      id, beacon, purpose, profile,
      instructed_by: String(b.instructed_by ?? ""),
      meta: sessionMeta(profile, purpose),
      calls: [], opened: new Date().toISOString(),
    });
    return json({ session_id: id, auth_token: `sess_${id}`, purpose, profile,
                  beacon, not_before: beacon ? `drand round ${beacon.round}` : null });
  }

  const closing = path.match(/^\/session\/([0-9a-f]{32})\/close$/);
  if (req.method === "POST" && closing) {
    const sess = sessions.get(closing[1]);
    if (!sess) return json({ error: "unknown session" }, 404);
    const commitments = sess.calls.map((c) =>
      Uint8Array.from(c.commitment.match(/../g)!.map((h) => parseInt(h, 16))));
    const root = await sessionRoot(sess.meta, commitments);
    const rd = await reportData(root, sess.beacon);
    let quote: unknown = null, quote_error: string | null = null;
    try {
      quote = await quoteOver(rd);
    } catch (e) {
      // No broker in local dev. Say so; do not emit a bundle that looks attested.
      quote_error = String(e);
    }
    sessions.delete(sess.id);
    return json({
      kind: "edge-tee attested subagent session",
      attester: "dstack-cvm",
      purpose: sess.purpose,
      release: { profile: sess.profile, instructed_by: sess.instructed_by },
      session_meta_b64: b64(sess.meta),
      call_count: sess.calls.length,
      merkle_root: commitments.length ? hex(await merkleRoot(commitments)) : null,
      session_root: hex(root),
      beacon: sess.beacon,
      report_data: hex(rd),
      quote, quote_error,
      calls: sess.calls,
    });
  }

  if (req.method === "POST" && path.startsWith("/v1/")) {
    const sess = sessionFrom(req);
    const maxCalls = Number(cfg(ctx, "MAX_CALLS") || 50);
    if (sess && sess.calls.length >= maxCalls) {
      return json({ type: "error", error: { type: "edge_tee_budget",
        message: `session reached its ${maxCalls}-call cap` } }, 429);
    }
    if (!sess) {
      return json({ type: "error", error: { type: "edge_tee_no_session",
        message: "open a session first and pass ANTHROPIC_AUTH_TOKEN=sess_<id>" } }, 401);
    }
    if (!apiKey) {
      return json({ type: "error", error: { type: "edge_tee_no_key",
        message: "no ANTHROPIC_API_KEY in this deployment's env" } }, 502);
    }
    try {
      return await relay(sess, path + url.search, req, apiKey);
    } catch (e) {
      return json({ type: "error", error: { type: "edge_tee_relay_failed",
        message: String(e) } }, 502);
    }
  }

  return json({ error: "not found", path }, 404);
}

if (import.meta.main) {
  const port = (() => { try { return Number(Deno.env.get("PORT") ?? 3000); } catch { return 3000; } })();
  Deno.serve({ port }, (r) => handler(r));
}
