// did:key UCAN-style capability tokens (RFC 0011) — offline delegation for the flows where
// the core steps OUT of the loop (e.g. screenshare-debug #51 direct signing). A faithful
// minimal subset of UCAN: iss/aud/att/prf, Ed25519 over a JWT, did:key principals. No deps —
// Ed25519 is native in Deno WebCrypto. Errors propagate with a reason; nothing is masked.

export interface Caveats {
  maxRate?: number;
  until?: number;
  sink?: string;
}
export interface Capability {
  with: string;
  can: string;
  nb?: Caveats;
}
export interface Payload {
  iss: string;
  aud: string;
  att: Capability[];
  exp: number;
  nbf?: number;
  prf: string[];
}
export interface Keypair {
  did: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

const enc = new TextEncoder();
const bs = (u: Uint8Array) => u as unknown as BufferSource; // Deno 2.x BufferSource is ArrayBuffer-strict
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDec = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const jsonB64 = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));

// --- base58btc (bitcoin alphabet), for did:key ---
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58enc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
function base58dec(str: string): Uint8Array {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes = [0];
  for (let i = zeros; i < str.length; i++) {
    const v = B58.indexOf(str[i]);
    if (v < 0) throw new Error(`bad base58 char: ${str[i]}`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + bytes.length - 1 - i] = bytes[i];
  return out;
}

// --- did:key <-> Ed25519 public key (multicodec 0xed01) ---
const ED_PREFIX = Uint8Array.from([0xed, 0x01]);
function didFromRaw(raw: Uint8Array): string {
  const p = new Uint8Array(ED_PREFIX.length + raw.length);
  p.set(ED_PREFIX);
  p.set(raw, ED_PREFIX.length);
  return "did:key:z" + base58enc(p);
}
function rawFromDid(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) throw new Error(`not a did:key: ${did}`);
  const p = base58dec(did.slice("did:key:z".length));
  if (p[0] !== 0xed || p[1] !== 0x01) throw new Error("did:key is not Ed25519");
  return p.slice(2);
}
async function pubKeyFromDid(did: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", bs(rawFromDid(did)), "Ed25519", true, ["verify"]);
}

export async function generateKeypair(): Promise<Keypair> {
  const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { did: didFromRaw(raw), privateKey: kp.privateKey, publicKey: kp.publicKey };
}

// --- mint / delegate ---
async function sign(payload: Payload, key: CryptoKey): Promise<string> {
  const head = jsonB64({ alg: "EdDSA", typ: "JWT", ucv: "0.1-oauth3" });
  const body = jsonB64(payload);
  const sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", key, bs(enc.encode(`${head}.${body}`))),
  );
  return `${head}.${body}.${b64url(sig)}`;
}

export interface MintOpts {
  issuer: Keypair;
  audience: string;
  capabilities: Capability[];
  expiresInSec: number;
  notBefore?: number;
  proofs?: string[];
  now?: number;
}
export async function mint(o: MintOpts): Promise<string> {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const payload: Payload = {
    iss: o.issuer.did,
    aud: o.audience,
    att: o.capabilities,
    exp: now + o.expiresInSec,
    prf: o.proofs ?? [],
  };
  if (o.notBefore) payload.nbf = o.notBefore;
  return await sign(payload, o.issuer.privateKey);
}
// delegate = mint with proofs=[parent]; issuer here is the parent's audience holder.
export const delegate = mint;

export function decode(token: string): Payload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  return JSON.parse(new TextDecoder().decode(b64urlDec(parts[1])));
}
async function sigValid(token: string): Promise<boolean> {
  const [h, b, s] = token.split(".");
  const p = JSON.parse(new TextDecoder().decode(b64urlDec(b))) as Payload;
  return await crypto.subtle.verify(
    "Ed25519",
    await pubKeyFromDid(p.iss),
    bs(b64urlDec(s)),
    bs(enc.encode(`${h}.${b}`)),
  );
}

// --- attenuation: is `child` a narrowing of `parent`? ---
function withCovers(parent: string, child: string): boolean {
  if (parent === child) return true;
  if (parent.endsWith("*")) return child.startsWith(parent.slice(0, -1));
  return false;
}
function canCovers(parent: string, child: string): boolean {
  if (parent === "*") return true;
  const p = parent.split("/"), c = child.split("/");
  if (p.length > c.length) return false;
  return p.every((seg, i) => seg === c[i]); // parent path is a prefix of child path
}
function caveatsNarrower(parent: Caveats | undefined, child: Caveats | undefined): string | null {
  const pr = parent ?? {}, ch = child ?? {};
  if (pr.maxRate !== undefined && (ch.maxRate === undefined || ch.maxRate > pr.maxRate)) {
    return "child maxRate exceeds parent";
  }
  if (pr.until !== undefined && (ch.until === undefined || ch.until > pr.until)) {
    return "child until later than parent";
  }
  if (pr.sink !== undefined && ch.sink !== pr.sink) return "child sink differs from parent";
  return null;
}
function attenuates(parent: Capability, child: Capability): boolean {
  return withCovers(parent.with, child.with) && canCovers(parent.can, child.can) &&
    caveatsNarrower(parent.nb, child.nb) === null;
}

// --- offline verification of the whole chain, trust-anchored at `root` did ---
export interface VerifyOpts {
  root: string;
  now?: number;
}
export async function verify(token: string, opts: VerifyOpts): Promise<Payload> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const p = decode(token);
  if (!await sigValid(token)) throw new Error(`bad signature for ${p.iss}`);
  if (p.nbf && now < p.nbf) throw new Error("token not yet valid (nbf)");
  if (now >= p.exp) throw new Error("token expired");
  if (p.prf.length === 0) {
    if (p.iss !== opts.root) throw new Error(`root issuer ${p.iss} is not the trusted root`);
    return p;
  }
  for (const proof of p.prf) {
    const parent = await verify(proof, opts); // recurse: validates parent chain to root
    if (p.iss !== parent.aud) {
      throw new Error(`chain break: ${p.iss} is not the audience of its proof (${parent.aud})`);
    }
    for (const cap of p.att) {
      if (!parent.att.some((pc) => attenuates(pc, cap))) {
        throw new Error(
          `capability {${cap.with} ${cap.can}} is not attenuated from any parent grant`,
        );
      }
    }
  }
  return p;
}

export interface Invocation {
  with: string;
  can: string;
  rate?: number;
  sink?: string;
}
// verify the chain AND that a leaf capability actually authorizes this invocation.
export async function canInvoke(
  token: string,
  req: Invocation,
  opts: VerifyOpts,
): Promise<Capability> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const p = await verify(token, opts);
  for (const cap of p.att) {
    if (!withCovers(cap.with, req.with) || !canCovers(cap.can, req.can)) continue;
    const nb = cap.nb ?? {};
    if (nb.maxRate !== undefined && req.rate !== undefined && req.rate > nb.maxRate) continue;
    if (nb.until !== undefined && now >= nb.until) continue;
    if (nb.sink !== undefined && req.sink !== nb.sink) continue;
    return cap;
  }
  throw new Error(`no capability authorizes ${req.can} on ${req.with}`);
}
