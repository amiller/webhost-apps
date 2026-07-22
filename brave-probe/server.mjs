// Brave-in-TEE probe: drives a real headless Brave (not chromium) via Playwright's
// executablePath, injects a cookie jar, runs the logged-in check. Deployed as a
// runtime=image project so it starts a container that egresses from the pod's IP.
//   GET  /brave-probe/ip                    -> egress + browser build
//   POST /brave-probe/run   {site, jar}     -> tuned site check
//   POST /brave-probe/probe {url, jar}      -> generic browser check (with/without-cookie differential)
import http from 'node:http';
import { chromium } from 'playwright';

const BRAVE = process.env.BRAVE_PATH || '/usr/bin/brave-browser';
const SECRET = process.env.PROBE_SECRET || '';
const PORT = Number(process.env.PORT || 8080);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SITES = {
  youtube: { url: 'https://www.youtube.com/account', confirm: async (p) => (await p.evaluate(() => { try { return String(window.ytcfg?.get?.('LOGGED_IN')); } catch { return 'err'; } })) === 'true' ? 'LOGGED_IN' : null },
  github: { url: 'https://github.com/settings/profile', confirm: async (p) => p.locator('meta[name="user-login"]').getAttribute('content').catch(() => null) },
  paypal: { url: 'https://www.paypal.com/myaccount/summary/', confirm: async (p) => p.evaluate(() => { const n = document.querySelectorAll('a[href*="/myaccount/"]').length; return (n > 5 && /log ?out|sign ?out/i.test(document.body.innerText) && !document.querySelector('input[type=password]')) ? `authed(${n})` : null; }).catch(() => null) },
  coinbase: { url: 'https://www.coinbase.com/settings', confirm: async (p) => p.evaluate(() => /log ?out|sign ?out/i.test(document.body.innerText) && !document.querySelector('input[type=password]') ? 'authed' : null).catch(() => null) },
  amazon: { url: 'https://www.amazon.com/gp/css/homepage.html', confirm: async (p) => p.evaluate(() => { const t = document.body.innerText; const m = t.match(/Hello,?\s+([^\n]{1,40})/); return /sign ?out/i.test(t) ? ('authed' + (m ? ' ' + m[1].trim() : '')) : null; }).catch(() => null) },
};

const readBody = (req) => new Promise((res, rej) => { let b = ''; req.on('data', c => { b += c; if (b.length > 6e6) req.destroy(); }); req.on('end', () => res(b)); req.on('error', rej); });
async function egress() { const r = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(8000) }); return await r.json(); }

async function drive(url, jar, confirm) {
  const browser = await chromium.launch({ executablePath: BRAVE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 }, ...(jar ? { storageState: jar } : {}) });
    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);
    const finalUrl = page.url();
    const pw = await page.locator('input[type=password]').count() > 0;
    const redirected = /\/login|\/signin|\/ap\/signin|accounts\.google|\/authflow/i.test(finalUrl) || pw;
    const identity = confirm ? await confirm(page) : (await page.evaluate(() => /log ?out|sign ?out/i.test(document.body.innerText) && !document.querySelector('input[type=password]') ? 'authed' : null).catch(() => null));
    const outcome = identity ? 'logged_in' : redirected ? 'broken_logged_out' : 'ambiguous';
    return { url, finalUrl, status: resp?.status() ?? null, outcome, identity, signals: { pw, redirected } };
  } finally { await browser.close(); }
}

http.createServer(async (req, res) => {
  const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if (SECRET && req.headers['x-probe-secret'] !== SECRET) return send(401, { error: 'bad secret' });
    if (req.method === 'GET' && path.endsWith('/ip')) return send(200, { egress: await egress(), brave: BRAVE });
    if (req.method === 'POST' && path.endsWith('/run')) {
      const { site, jar } = JSON.parse(await readBody(req) || '{}');
      const cfg = SITES[site]; if (!cfg) return send(400, { error: 'unknown site' });
      const out = await drive(cfg.url, jar || null, cfg.confirm); out.site = site; out.egress = await egress().catch(() => null);
      return send(200, out);
    }
    if (req.method === 'POST' && path.endsWith('/probe')) {
      const { url, jar } = JSON.parse(await readBody(req) || '{}');
      if (!url) return send(400, { error: 'url required' });
      const withJar = await drive(url, jar || null, null);
      const withoutJar = await drive(url, null, null);
      const flip = withJar.outcome === 'logged_in' && withoutJar.outcome !== 'logged_in';
      const out = { url, outcome: flip ? 'logged_in' : withJar.outcome, with: withJar, without: withoutJar, egress: await egress().catch(() => null) };
      return send(200, out);
    }
    return send(404, { error: 'GET /ip | POST /run {site,jar} | POST /probe {url,jar}' });
  } catch (e) { send(500, { error: String(e).slice(0, 300) }); }
}).listen(PORT, () => console.log('brave-probe on', PORT, 'via', BRAVE));
