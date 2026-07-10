// Shared teleport-probe core: used by the CLI (probe.mjs) and the in-TEE
// server (webhost-apps/teleport-probe/server.mjs). Positive-identity classifier.
export const SITES = {
  youtube: {
    url: 'https://www.youtube.com/account',
    loginRe: /accounts\.google\.com|ServiceLogin/i,
    confirm: async (p) => {
      const li = await p.evaluate(() => { try { return String(window.ytcfg?.get?.('LOGGED_IN') ?? window.ytcfg?.data_?.LOGGED_IN); } catch { return 'err'; } });
      return li === 'true' ? 'LOGGED_IN' : null;
    },
  },
  github: {
    url: 'https://github.com/settings/profile',
    loginRe: /github\.com\/login|\/session/i,
    confirm: async (p) => (await p.locator('meta[name="user-login"]').getAttribute('content').catch(()=>null)),
  },
  paypal: {  // READ-ONLY: never click, never submit
    url: 'https://www.paypal.com/myaccount/summary/',
    loginRe: /\/signin|\/login|\/authflow/i,
    confirm: async (p) => p.evaluate(() => {
      const nav = document.querySelectorAll('a[href*="/myaccount/"]').length;
      const logout = /log ?out|sign ?out/i.test(document.body.innerText);
      const pw = document.querySelectorAll('input[type=password]').length;
      return (nav > 5 && logout && !pw) ? `authed(${nav} myaccount-links)` : null;
    }).catch(()=>null),
  },
};

// opts: { chromium, site, storageState (obj|path|null), proxy, screenshotPath }
export async function runProbe({ chromium, site, storageState, proxy, screenshotPath }) {
  const cfg = SITES[site];
  if (!cfg) throw new Error('unknown site ' + site);
  const launchOpts = { headless: true };
  if (proxy) launchOpts.proxy = { server: proxy };
  const browser = await chromium.launch(launchOpts);
  const ctxOpts = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  };
  if (storageState) ctxOpts.storageState = storageState;
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const net = [];
  page.on('response', r => { if (net.length < 4) net.push({ url: r.url().slice(0,90), status: r.status() }); });
  const out = { site, url: cfg.url, cookies: !!storageState };
  try {
    const resp = await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3800);
    out.finalUrl = page.url(); out.status = resp ? resp.status() : null; out.title = await page.title();
    const identity = storageState ? await cfg.confirm(page).catch(()=>null) : null;
    const pwField = await page.locator('input[type=password]').count() > 0;
    const redirected = cfg.loginRe.test(page.url()) || pwField;
    const t = (out.title||'').toLowerCase();
    const h1 = ((await page.locator('h1').first().textContent().catch(()=>'')) || '').toLowerCase();
    const challenge = /verify it'?s you|confirm your identity|unusual (sign|activity)|suspicious|are you a (robot|human)|check.?your.?(phone|email)/.test(t+' '+h1)
                      || (await page.locator('iframe[src*="captcha" i],iframe[title*="captcha" i]').count()) > 0;
    out.outcome = identity ? 'logged_in' : redirected ? 'broken_logged_out' : challenge ? 'step_up' : 'ambiguous';
    out.identity = identity; out.signals = { pwField, redirected, challenge }; out.net = net;
    if (screenshotPath) { await page.screenshot({ path: screenshotPath }).catch(()=>{}); out.screenshot = screenshotPath; }
  } catch (e) { out.outcome = 'error'; out.error = String(e).slice(0,300); }
  await browser.close();
  return out;
}
