// In-TEE teleport probe (deno runtime). Runs HTTP-layer login checks from the
// CVM's cloud IP: fetch the site's logged-in-only URL with the caller-supplied
// cookies and classify. No browser (shared runtimes bundle no chromium), so this
// is a stricter IP-only teleport test. Guarded by PROBE_SECRET (ctx.env).
//   GET  /teleport-probe/ip                   -> egress {ip,org,city,country}
//   POST /teleport-probe/run {site, cookies}  -> outcome JSON
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SITES: Record<string, { url: string; classify: (st: number, loc: string, body: string) => { outcome: string; identity: string | null } }> = {
  github: {
    url: "https://github.com/settings/profile",
    classify: (_st, loc, body) => {
      const m = body.match(/name="user-login" content="([^"]+)"/);
      if (m) return { outcome: "logged_in", identity: m[1] };
      if (/\/login/.test(loc) || /Sign in to GitHub/i.test(body)) return { outcome: "broken_logged_out", identity: null };
      return { outcome: "ambiguous", identity: null };
    },
  },
  youtube: {
    url: "https://www.youtube.com/",
    classify: (_st, loc, body) => {
      if (/"LOGGED_IN":\s*true/.test(body)) return { outcome: "logged_in", identity: "LOGGED_IN" };
      if (/accounts\.google\.com/.test(loc) || /"LOGGED_IN":\s*false/.test(body)) return { outcome: "broken_logged_out", identity: null };
      return { outcome: "ambiguous", identity: null };
    },
  },
  paypal: {
    url: "https://www.paypal.com/myaccount/summary/",
    classify: (st, loc, body) => {
      if (/signin|\/login|authflow/i.test(loc)) return { outcome: "broken_logged_out", identity: null };
      const n = (body.match(/\/myaccount\//g) || []).length;
      if (st === 200 && n > 5 && /log ?out|sign ?out/i.test(body)) return { outcome: "logged_in", identity: `authed(${n} myaccount-links)` };
      return { outcome: "ambiguous", identity: null };
    },
  },
};

async function egress() {
  const r = await fetch("https://ipinfo.io/json", { signal: AbortSignal.timeout(8000) });
  const d = await r.json();
  return { ip: d.ip, org: d.org, city: d.city, country: d.country };
}

function genericClassify(status: number, loc: string, body: string) {
  if (/\/login|\/signin|\/sign-in|\/sign_in|\/ap\/signin|\/uas\/login|accounts\.google|\/authflow|\/auth\//i.test(loc))
    return { outcome: "broken_logged_out", why: "redirect->login" };
  const hasPw = /type=["']?password|name=["']?password/i.test(body);
  const hasLogout = /log ?out|sign ?out|"loggedin":\s*true|"isloggedin":\s*true|my account/i.test(body);
  if (hasPw && !hasLogout) return { outcome: "broken_logged_out", why: "password-form" };
  if (hasLogout) return { outcome: "logged_in", why: "logout-marker" };
  return { outcome: "ambiguous", why: "no-clear-signal" };
}

const json = (code: number, obj: unknown) => new Response(JSON.stringify(obj), { status: code, headers: { "content-type": "application/json" } });

export default async function handler(req: Request, ctx?: { env: Record<string, string> }) {
  const secret = ctx?.env?.PROBE_SECRET || "";
  const path = new URL(req.url).pathname;
  if (secret && req.headers.get("x-probe-secret") !== secret) return json(401, { error: "bad secret" });
  if (req.method === "GET" && path.endsWith("/ip")) return json(200, await egress());
  if (req.method === "POST" && path.endsWith("/run")) {
    const { site, cookies } = await req.json();
    const cfg = SITES[site];
    if (!cfg) return json(400, { error: "unknown site" });
    let resp: Response;
    try {
      resp = await fetch(cfg.url, { headers: { "cookie": cookies || "", "user-agent": UA, "accept-language": "en-US,en;q=0.9" }, redirect: "manual", signal: AbortSignal.timeout(25000) });
    } catch (e) {
      return json(200, { site, outcome: "error", error: String(e).slice(0, 200), egress: await egress().catch(() => null) });
    }
    const loc = resp.headers.get("location") || "";
    const body = await resp.text();
    const { outcome, identity } = cfg.classify(resp.status, loc, body);
    return json(200, { site, url: cfg.url, status: resp.status, location: loc.slice(0, 120), outcome, identity, bodyLen: body.length, egress: await egress().catch(() => null) });
  }
  if (req.method === "POST" && path.endsWith("/probe")) {
    const { url, cookies } = await req.json();
    if (!url) return json(400, { error: "url required" });
    const one = async (ck: string) => {
      const r = await fetch(url, { headers: { "cookie": ck, "user-agent": UA, "accept-language": "en-US,en;q=0.9" }, redirect: "manual", signal: AbortSignal.timeout(25000) });
      const body = await r.text();
      return { status: r.status, loc: (r.headers.get("location") || "").slice(0, 120), len: body.length };
    };
    let W, N;
    try { W = await one(cookies || ""); N = await one(""); }
    catch (e) { return json(200, { url, outcome: "error", error: String(e).slice(0, 200) }); }
    const loginRe = /\/login|\/signin|\/sign-in|\/ap\/signin|\/uas\/login|accounts\.google|\/authflow/i;
    const wLogin = loginRe.test(W.loc), nLogin = loginRe.test(N.loc);
    // Differential: does the cookie flip anon->authed?
    let outcome: string, why: string;
    if (wLogin) { outcome = "broken_logged_out"; why = "cookie->login-redirect"; }
    else if (nLogin && !wLogin) { outcome = "logged_in"; why = "cookie flips 302-login -> 200"; }
    else if (!wLogin && !nLogin) {
      const ratio = W.len / Math.max(N.len, 1);
      if (ratio > 1.5) { outcome = "logged_in"; why = `size-delta ${W.len} vs ${N.len} (${ratio.toFixed(1)}x)`; }
      else { outcome = "ambiguous"; why = `no-flip, size ${W.len} vs ${N.len}`; }
    } else { outcome = "ambiguous"; why = "both redirect to login"; }
    return json(200, { url, outcome, why, with: W, without: N });
  }
  return json(404, { error: "GET /ip | POST /run {site,cookies} | POST /probe {url,cookies}" });
}

if (import.meta.main) Deno.serve({ port: Number(Deno.env.get("PORT") || 8080) }, (req) => handler(req, { env: { PROBE_SECRET: Deno.env.get("PROBE_SECRET") || "" } }));
