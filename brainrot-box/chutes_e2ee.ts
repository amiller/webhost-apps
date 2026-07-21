// Chutes end-to-end encryption (post-quantum) for OpenAI-compatible chat completions.
// Reimplements the reference OpenResty proxy protocol (chutes-research/e2ee-proxy) in TS:
//   discover instance ML-KEM-768 pubkey -> encapsulate -> HKDF-SHA256 -> ChaCha20-Poly1305 over gzip,
//   POST binary blob to api.chutes.ai/e2e/invoke, decrypt the streamed SSE. Only the GPU TEE instance
//   can decrypt the prompt. FIPS-203 ML-KEM-768 interoperates with Chutes' native lib.
import { ml_kem768 } from "npm:@noble/post-quantum@0.4.1/ml-kem";
import { chacha20poly1305 } from "npm:@noble/ciphers@1.2.1/chacha";
import { hkdf } from "npm:@noble/hashes@1.7.1/hkdf";
import { sha256 } from "npm:@noble/hashes@1.7.1/sha2";
import { gzipSync } from "node:zlib";

const API = "https://api.chutes.ai";
const MODELS = "https://llm.chutes.ai";
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64e = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const cat = (...xs: Uint8Array[]) => { const t = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { t.set(x, o); o += x.length; } return t; };
const dk = (ss: Uint8Array, ct: Uint8Array, info: string) => hkdf(sha256, ss, ct.slice(0, 16), new TextEncoder().encode(info), 32);

const chuteCache = new Map<string, string>();
async function chuteId(model: string, key: string): Promise<string> {
  if (chuteCache.has(model)) return chuteCache.get(model)!;
  const r = await fetch(`${MODELS}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`chutes models ${r.status}`);
  const m = (await r.json()).data.find((x: any) => x.id === model);
  if (!m?.chute_id) throw new Error(`chutes model not found: ${model}`);
  chuteCache.set(model, m.chute_id);
  return m.chute_id;
}

async function instance(cid: string, key: string): Promise<{ instance_id: string; e2e_pubkey: string; nonce: string }> {
  const r = await fetch(`${API}/e2e/instances/${cid}`, { headers: { Authorization: `Bearer ${key}`, "Cache-Control": "no-cache, no-store" } });
  if (!r.ok) throw new Error(`chutes instances ${r.status}: ${await r.text()}`);
  const insts = (await r.json()).instances;
  for (const i of insts) if (i.nonces?.length) return { instance_id: i.instance_id, e2e_pubkey: i.e2e_pubkey, nonce: i.nonces[0] };
  throw new Error(`no e2ee instances/nonces for chute ${cid}`);
}

function buildBlob(pubkeyB64: string, payload: unknown): { blob: Uint8Array; respSk: Uint8Array } {
  const resp = ml_kem768.keygen();
  const { cipherText: mlkemCt, sharedSecret: ss } = ml_kem768.encapsulate(b64d(pubkeyB64));
  const key = dk(ss, mlkemCt, "e2e-req-v1");
  const aug = JSON.stringify({ ...(payload as object), e2e_response_pk: b64e(resp.publicKey) });
  const gz = new Uint8Array(gzipSync(new TextEncoder().encode(aug)));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = chacha20poly1305(key, nonce).encrypt(gz); // ct||tag(16)
  return { blob: cat(mlkemCt, nonce, sealed), respSk: resp.secretKey };
}

// Stream OpenAI chat completions over Chutes e2ee. Calls onDelta(text) for each content delta.
export async function chutesStream(
  apiKey: string, model: string, body: Record<string, unknown>, onDelta: (t: string) => void, signal?: AbortSignal,
): Promise<void> {
  const cid = await chuteId(model, apiKey);
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const inst = await instance(cid, apiKey);
    const { blob, respSk } = buildBlob(inst.e2e_pubkey, { ...body, model, stream: true });
    const reqBody = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
    const r = await fetch(`${API}/e2e/invoke`, {
      method: "POST", signal, body: reqBody,
      headers: {
        Authorization: `Bearer ${apiKey}`, "X-Chute-Id": cid, "X-Instance-Id": inst.instance_id,
        "X-E2E-Nonce": inst.nonce, "X-E2E-Stream": "true", "X-E2E-Path": "/v1/chat/completions",
        "Content-Type": "application/octet-stream",
      },
    });
    if (r.status === 403 && attempt === 0) { last = await r.text(); if (last.includes("nonce")) continue; }
    if (!r.ok) throw new Error(`chutes /e2e/invoke ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let streamKey: Uint8Array | null = null;
    const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]" || raw === "") continue;
        let ev: any; try { ev = JSON.parse(raw); } catch { continue; }
        if (ev.e2e_init) { streamKey = dk(ml_kem768.decapsulate(b64d(ev.e2e_init), respSk), b64d(ev.e2e_init), "e2e-stream-v1"); }
        else if (ev.e2e && streamKey) {
          const c = b64d(ev.e2e);
          const plain = new TextDecoder().decode(chacha20poly1305(streamKey, c.slice(0, 12)).decrypt(c.slice(12)));
          const pl = plain.startsWith("data:") ? plain.slice(plain.indexOf(":") + 1).trim() : plain.trim();
          if (pl && pl !== "[DONE]") { try { const d = JSON.parse(pl).choices?.[0]?.delta?.content; if (d) onDelta(d); } catch { /* skip */ } }
        }
      }
    }
    return;
  }
  throw new Error(`chutes nonce retry exhausted: ${last.slice(0, 200)}`);
}

if (import.meta.main) {
  const key = Deno.env.get("CHUTES_API_KEY")!;
  const model = Deno.args[0] ?? "unsloth/Mistral-Nemo-Instruct-2407-TEE";
  const t0 = Date.now(); let first = 0; let out = "";
  await chutesStream(key, model, { max_tokens: 60, messages: [{ role: "user", content: "In one short sentence, what is a TEE?" }] },
    (t) => { if (!first) first = Date.now() - t0; out += t; });
  console.log(`model=${model}\nttft=${first}ms total=${Date.now() - t0}ms\nDECRYPTED: ${out}`);
}
