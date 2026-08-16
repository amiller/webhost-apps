// NEAR AI Cloud end-to-end encryption for OpenAI-compatible chat completions.
// Reimplements the ECIES scheme of nearai-cloud-verifier: fetch the model CVM's attested
// secp256k1 signing_public_key, encrypt each message with ECDH->HKDF-SHA256->AES-GCM, decrypt the
// streamed delta.content. Only the model's TDX+H100 enclave can read the prompt.
import { secp256k1 } from "npm:@noble/curves@1.8.1/secp256k1";
import { hkdf } from "npm:@noble/hashes@1.7.1/hkdf";
import { sha256 } from "npm:@noble/hashes@1.7.1/sha2";

const BASE = "https://cloud-api.near.ai/v1";
const INFO = new TextEncoder().encode("ecdsa_encryption");
const hx = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const uhx = (s: string) => { const b = new Uint8Array(s.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return b; };
const cat = (...xs: Uint8Array[]) => { const t = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { t.set(x, o); o += x.length; } return t; };
// python cryptography ECDH returns the 32-byte X coordinate; HKDF salt=None -> 32 zero bytes.
const sharedX = (priv: Uint8Array, pub: Uint8Array) => secp256k1.getSharedSecret(priv, pub, true).slice(1);
const aesKey = (x: Uint8Array) => hkdf(sha256, x, new Uint8Array(32), INFO, 32);

async function aesGcm(mode: "enc" | "dec", key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, [mode === "enc" ? "encrypt" : "decrypt"]);
  const fn = mode === "enc" ? crypto.subtle.encrypt : crypto.subtle.decrypt;
  return new Uint8Array(await fn.call(crypto.subtle, { name: "AES-GCM", iv: new Uint8Array(iv) }, k, new Uint8Array(data)));
}

// ECIES encrypt to a 64-byte (X962 uncompressed, no prefix) or 65-byte model pubkey -> hex(eph65||iv12||ct+tag)
async function encrypt(plaintext: string, modelPubHex: string): Promise<string> {
  let pb = uhx(modelPubHex);
  if (pb.length === 64) pb = cat(new Uint8Array([4]), pb);
  const eph = secp256k1.utils.randomPrivateKey();
  const key = aesKey(sharedX(eph, pb));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await aesGcm("enc", key, iv, new TextEncoder().encode(plaintext));
  const ephPub = secp256k1.getPublicKey(eph, false); // 65-byte uncompressed
  return hx(cat(ephPub, iv, ct));
}

async function decrypt(hex: string, clientPriv: Uint8Array): Promise<string> {
  const b = uhx(hex);
  const key = aesKey(sharedX(clientPriv, b.slice(0, 65)));
  return new TextDecoder().decode(await aesGcm("dec", key, b.slice(65, 77), b.slice(77)));
}

const pkCache = new Map<string, string>();
// Attestation state for the UI. verified=false means the box is running on an
// UNVERIFIED (TOFU) enclave key: by explicit call (7/22), a stale pin — NEAR
// rotates images often — must not take the demo down; the page shows a note.
export const attestation = { verified: null as boolean | null, note: "", at: 0 };
// Attested pubkey via the bundled attest-verify sidecar (bitrouter-attestation):
// DCAP quote chain + NVIDIA NRAS + pinned policy; report_data binds the key.
// No TOFU (webhost-apps#105). pins = NEAR_WORKLOAD_IDS / NEAR_IMAGE_DIGESTS /
// NEAR_KMS_ROOTS / NEAR_BASE_MEASUREMENTS — the sidecar refuses to run unpinned.
async function modelPubkey(model: string, pins: Record<string, string>, apiKey: string): Promise<string> {
  if (pkCache.has(model)) return pkCache.get(model)!;
  let key: string;
  try {
    // Deployed: the binary sits beside this module. Dev checkout: that path is
    // the cargo dir, so use its build output.
    let bin = new URL("./attest-verify", import.meta.url).pathname;
    if (Deno.statSync(bin).isDirectory) bin += "/target/release/attest-verify";
    // SSL_CERT_FILE: the shared deno container has no system CA store for rustls.
    // NEAR_API_KEY passed explicitly — the report endpoint requires Bearer auth
    // and the child must not depend on env-inheritance details.
    const env = { ...pins, NEAR_API_KEY: apiKey, SSL_CERT_FILE: new URL("./ca-bundle.crt", import.meta.url).pathname };
    const out = await new Deno.Command(bin, { args: [model], env, stdout: "piped", stderr: "piped" }).output();
    const stdout = new TextDecoder().decode(out.stdout);
    if (!out.success) throw new Error((stdout || new TextDecoder().decode(out.stderr)).slice(0, 600));
    const v = JSON.parse(stdout);
    if (!v.verified || !v.signing_public_key) throw new Error("unverified: " + JSON.stringify(v.checks));
    key = v.signing_public_key;
    attestation.verified = true; attestation.note = ""; attestation.at = Date.now();
  } catch (e) {
    attestation.verified = false; attestation.at = Date.now();
    attestation.note = `enclave key UNVERIFIED (${String((e as Error).message ?? e).slice(0, 600)}) — e2ee still on, attestation degraded`;
    const r = await fetch(`${BASE}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!r.ok) throw new Error(`near attestation ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const rep = await r.json();
    const att = (rep.model_attestations ?? []).find((m: { signing_public_key?: string }) => m.signing_public_key);
    if (!att) throw new Error(`near ${model}: no signing_public_key (not e2ee-capable)`);
    key = att.signing_public_key;
  }
  pkCache.set(model, key);
  return key;
}

// Stream OpenAI chat completions over NEAR e2ee. Calls onDelta(text) for each content delta.
export async function nearStream(
  apiKey: string, pins: Record<string, string>, model: string, body: Record<string, unknown>, onDelta: (t: string) => void, signal?: AbortSignal,
): Promise<void> {
  const pk = await modelPubkey(model, pins, apiKey);
  const clientPriv = secp256k1.utils.randomPrivateKey();
  const clientPub = hx(secp256k1.getPublicKey(clientPriv, false).slice(1)); // 64-byte, no prefix
  const msgs = await Promise.all((body.messages as any[]).map(async (m) =>
    typeof m.content === "string" && m.content ? { ...m, content: await encrypt(m.content, pk) } : m));
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "X-Signing-Algo": "ecdsa", "X-Client-Pub-Key": clientPub, "X-Model-Pub-Key": pk },
    body: JSON.stringify({ ...body, model, messages: msgs, stream: true }),
  });
  if (!r.ok) throw new Error(`near /chat/completions ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
      const c = ev.choices?.[0]?.delta?.content;
      if (typeof c === "string" && c) onDelta(await decrypt(c, clientPriv));
    }
  }
}

if (import.meta.main) {
  const key = Deno.env.get("NEAR_API_KEY")!;
  const pins = Object.fromEntries(
    ["NEAR_WORKLOAD_IDS", "NEAR_IMAGE_DIGESTS", "NEAR_KMS_ROOTS", "NEAR_BASE_MEASUREMENTS"]
      .flatMap((k) => { const v = Deno.env.get(k); return v ? [[k, v]] : []; }));
  const model = Deno.args[0] ?? "deepseek-ai/DeepSeek-V4-Flash";
  const t0 = Date.now(); let first = 0; let out = "";
  await nearStream(key, pins, model, { max_tokens: 60, messages: [{ role: "user", content: "In one short sentence, what is a TEE?" }] },
    (t: string) => { if (!first) first = Date.now() - t0; out += t; });
  console.log(`model=${model}\nttft=${first}ms total=${Date.now() - t0}ms\nDECRYPTED: ${out}`);
}
