// In-TEE teleport probe: runs the session-teleport check INSIDE the CVM, so the
// browser egresses from the pod's cloud IP (the C2 datacenter-egress leg).
// Deployed as a dstack-webhost Dockerfile app; ingress path-proxies /teleport-probe/.
//
// Endpoints (prefix-tolerant):
//   GET  .../ip            -> {ip, org, city, country}  egress sanity check
//   POST .../run           -> {site, jar}  runs headless probe, returns outcome JSON
// Guard: every request must carry  X-Probe-Secret: $PROBE_SECRET  (env).
// The jar (live session cookies) is supplied per-request by the caller, never stored.
import http from 'node:http';
import { chromium } from 'playwright';
import { runProbe } from './probe-core.mjs';

const SECRET = process.env.PROBE_SECRET || '';
const PORT = Number(process.env.PORT || 8080);

const readBody = (req) => new Promise((res, rej) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
  req.on('end', () => res(b)); req.on('error', rej);
});

async function egressInfo() {
  const r = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(8000) });
  const d = await r.json();
  return { ip: d.ip, org: d.org, city: d.city, country: d.country };
}

http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if (SECRET && req.headers['x-probe-secret'] !== SECRET) return send(401, { error: 'bad secret' });
    if (req.method === 'GET' && path.endsWith('/ip')) return send(200, await egressInfo());
    if (req.method === 'POST' && path.endsWith('/run')) {
      const { site, jar } = JSON.parse(await readBody(req) || '{}');
      if (!site) return send(400, { error: 'site required' });
      const out = await runProbe({ chromium, site, storageState: jar || null });
      out.egress = await egressInfo().catch(() => null);
      return send(200, out);
    }
    return send(404, { error: 'GET /ip or POST /run' });
  } catch (e) { send(500, { error: String(e).slice(0, 300) }); }
}).listen(PORT, () => console.log('teleport-probe on', PORT));
