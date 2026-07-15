#!/usr/bin/env python3
"""End-to-end browser test for the Google Calendar connection (P3).

Mocks the entire Google side (OAuth consent → token → userinfo → calendar) so the real
redirect chain runs in Chromium with no live Google account:
  click "connect Google" → /google/auth → (mock consent 302) → /google/callback → token
  exchange + userinfo → stored → back to app → Google card connected + next meetings shown.

  python3 otter_web/e2e_google.py
"""
import base64, json, os, socket, subprocess, sys, tempfile, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlparse, parse_qs
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = REPO / "tasks" / "e2e-google"
GMAIL = "demo@gmail.com"
EVENT = "IC3 sync — connections review"


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class MockGoogle(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path.endswith("/auth"):  # instant "consent": bounce straight back to the app callback
            loc = f"{q['redirect_uri'][0]}?code=FAKECODE&state={q.get('state', [''])[0]}"
            self.send_response(302); self.send_header("Location", loc); self.end_headers(); return
        if u.path.endswith("/primary"):  # identity = primary calendar id
            return self._json({"id": GMAIL})
        if u.path.endswith("/user"):      # otter session probe (kept healthy so /conversations lists)
            return self._json({"userid": 7, "email": "owner@otter"})
        if u.path.endswith("/speeches"):
            return self._json({"speeches": []})
        if u.path.endswith("/events"):
            ev = {"summary": EVENT, "start": {"dateTime": "2031-03-04T15:00:00Z"},
                  "end": {"dateTime": "2031-03-04T16:00:00Z"}, "hangoutLink": "https://meet.google.com/abc-defg-hij",
                  "attachments": [{"title": "Notes by Gemini", "fileId": "FILE1"}]}
            return self._json({"items": [ev, dict(ev)]})  # recurring duplicate → must dedupe to one note
        if u.path.endswith("/export"):  # Drive plain-text export of the Gemini doc (5 lines → 1 decode batch)
            txt = ("Meeting summary\nDiscussed the connections panel rollout.\n"
                   "Decision: ship Gemini notes import.\nAction item: wire the Drive export path.\n"
                   "Next steps reviewed.").encode()
            self.send_response(200); self.send_header("content-type", "text/plain")
            self.send_header("content-length", str(len(txt))); self.end_headers(); self.wfile.write(txt); return
        return self._json({})
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        if self.path.endswith("/near"):  # decoder LLM call → one typed node
            content = json.dumps({"nodes": [{"i": 0, "kind": "action_item", "topic": "Follow-ups",
                                             "text": "wire the Drive export path", "rel": "new-topic"}]})
            return self._json({"choices": [{"message": {"content": content}}]})
        return self._json({"access_token": "AT", "refresh_token": "RT", "expires_in": 3600})


def wait_up(url, tries=50):
    for _ in range(tries):
        try: urlopen(url, timeout=1); return
        except Exception: time.sleep(0.2)
    raise RuntimeError(f"server never came up: {url}")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    gport, app_port = free_port(), free_port()
    gbase, app = f"http://127.0.0.1:{gport}", f"http://127.0.0.1:{app_port}"

    mock = ThreadingHTTPServer(("127.0.0.1", gport), MockGoogle)
    Thread(target=mock.serve_forever, daemon=True).start()

    # synthetic authorized-user token file — same shape as the real calendar_token.json, so this
    # exercises the owner token-file code path with no real secrets.
    tokfile = Path(tempfile.mkdtemp(prefix="gtok-")) / "calendar_token.json"
    tokfile.write_text(json.dumps({"client_id": "cid", "client_secret": "sec",
                                   "refresh_token": "RT", "token_uri": f"{gbase}/token"}))

    env = dict(os.environ, NEAR_KEY="dummy", OWNER_TOKEN="OWN",
               GOOGLE_CLIENT_ID="cid", GOOGLE_CLIENT_SECRET="sec",
               GOOGLE_REDIRECT_URI=f"{app}/google/callback", BASE_URL=app,
               GOOGLE_OAUTH_AUTH=f"{gbase}/o/oauth2/v2/auth", GOOGLE_OAUTH_TOKEN=f"{gbase}/token",
               GOOGLE_CAL_PRIMARY=f"{gbase}/primary", GOOGLE_CALENDAR=f"{gbase}/events",
               GOOGLE_DRIVE=f"{gbase}/drive", GOOGLE_TOKEN_FILE=str(tokfile), NEAR_URL=f"{gbase}/near",
               OTTER_API_BASE=f"{gbase}/", OTTER_SESSION="sealed",
               OTTER_SESSIONID="x", OTTER_CSRFTOKEN="y",
               OTTER_OUT=tempfile.mkdtemp(prefix="otter-e2e-g-"), PORT=str(app_port), HOST="127.0.0.1")
    proc = subprocess.Popen([sys.executable, "server.py"], cwd=str(HERE), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    results = []

    def check(name, cond, detail=""):
        results.append((name, bool(cond), detail)); print(("  PASS " if cond else "  FAIL ") + name + (f" — {detail}" if detail else ""))

    def gcard(page):
        return page.evaluate("""() => { const c = [...document.querySelectorAll('#connections .conn')]
            .find(c => (c.querySelector('.name')?.textContent||'').toLowerCase().startsWith('google'));
            return c ? {cls:c.className.trim(), who:c.querySelector('.who')?.textContent||'',
                       cal:c.querySelector('.cal')?.textContent||'',
                       cta:c.querySelector('[data-go]')?.textContent||''} : null; }""")

    try:
        wait_up(app + "/")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(viewport={"width": 1100, "height": 760})
            page = ctx.new_page()
            page.goto(app + "/"); page.wait_for_selector("#connections .conn")
            g = gcard(page)
            check("google card present + configured", g and "on" not in g["cls"].split() and "connect Google" in g["cta"],
                  json.dumps(g))
            page.screenshot(path=str(OUT / "01-google-disconnected.png"), full_page=True)

            page.click('[data-go]')                          # full OAuth redirect chain (mocked consent)
            page.wait_for_url(app + "/")                      # callback lands us back at the app root
            page.wait_for_selector("#connections .cal")       # calendar slot only exists once connected
            page.wait_for_function("() => !document.querySelector('#connections .cal .ph')")  # calendar loaded
            g = gcard(page)
            check("google connected after OAuth", "on" in g["cls"].split() and GMAIL in g["who"], json.dumps(g))
            check("calendar event rendered", EVENT in g["cal"], g["cal"])
            page.screenshot(path=str(OUT / "02-google-connected.png"), full_page=True)
            ctx.close()

            # ---- scenario 3: OWNER reusing an existing token file (no OAuth click) ----
            octx = browser.new_context(viewport={"width": 1100, "height": 760})
            opage = octx.new_page()
            opage.goto(app + "/#owner=OWN"); opage.wait_for_selector("#connections .conn")
            opage.wait_for_function("() => { const c=[...document.querySelectorAll('#connections .conn')]"
                                    ".find(c=>(c.querySelector('.name')?.textContent||'').toLowerCase().startsWith('google'));"
                                    " return c && c.className.split(' ').includes('on'); }")
            opage.wait_for_function("() => !document.querySelector('#connections .cal .ph')")
            g = gcard(opage)
            check("owner: Google connected via token file (no OAuth)", "on" in g["cls"].split() and GMAIL in g["who"],
                  json.dumps(g))
            check("owner: calendar event rendered", EVENT in g["cal"], g["cal"])
            opage.screenshot(path=str(OUT / "03-owner-tokenfile.png"), full_page=True)

            # ---- scenario 4: scan + import a Gemini note (Drive export → decode pipeline) ----
            opage.click('[data-gem-scan]')
            opage.wait_for_selector('.gem .gimp')
            check("gemini: note listed", EVENT in opage.inner_text('.gem'), opage.inner_text('.gem'))
            nrows = opage.eval_on_selector_all('.gem .gemrow', "els => els.length")
            check("gemini: recurring duplicate deduped to one", nrows == 1, f"{nrows} rows")
            opage.click('.gem .gimp')
            opage.wait_for_function("() => /imported/.test(document.querySelector('#connections .gem .gimp')?.textContent||'')")
            imp = opage.inner_text('#connections .gem .gimp')
            check("gemini: imported with decoded nodes", "imported" in imp and "(0 nodes)" not in imp, imp)
            convs = opage.evaluate("""async () => { const t = localStorage.getItem('otter_owner_token');
                const r = await fetch('/conversations', {headers: {'X-Auth-Token': t}}); return await r.json(); }""")
            check("gemini: appears as a conversation", any(c.get("otid") == "gem_FILE1" for c in convs),
                  f"{len(convs)} conversations")
            opage.screenshot(path=str(OUT / "04-gemini-import.png"), full_page=True)
            octx.close(); browser.close()
    finally:
        proc.terminate()
        try: proc.wait(timeout=5)
        except Exception: proc.kill()
        mock.shutdown()

    write_report(results)
    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


def write_report(results):
    shots = [("01-google-disconnected.png", "Google not connected — 'connect Google' CTA (OAuth configured)"),
             ("02-google-connected.png", "After per-user OAuth — Google connected + next meetings"),
             ("03-owner-tokenfile.png", "Owner reusing an existing token file (no OAuth) — connected + meetings"),
             ("04-gemini-import.png", "Gemini notes scanned + imported (Drive export → decode pipeline → conversation)")]
    passed = sum(1 for _, ok, _ in results if ok)
    esc = lambda s: (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    rows = "".join(f'<tr class="{"ok" if ok else "bad"}"><td>{i}</td><td>{esc(name)}</td>'
                   f'<td>{"✅" if ok else "❌"}</td><td><code>{esc(detail.replace(chr(10)," ")[:120])}</code></td></tr>'
                   for i, (name, ok, detail) in enumerate(results, 1))
    figs = "".join(f'<figure><figcaption>{esc(cap)}</figcaption>'
                   f'<img src="data:image/png;base64,{base64.b64encode((OUT / fn).read_bytes()).decode()}"></figure>'
                   for fn, cap in shots)
    html = f"""<!doctype html><meta charset=utf-8><title>Google Calendar — E2E report</title>
<style>
 body{{margin:0;background:#0b0c10;color:#d7dae0;font:15px/1.55 ui-monospace,Menlo,monospace;padding:28px 36px}}
 h1{{color:#8ad;font-size:20px}} .sub{{color:#8a909c;font-size:13px;margin:-6px 0 22px}}
 .pill{{display:inline-block;background:#0c2c1a;color:#2eea7e;font-weight:700;padding:3px 11px;border-radius:7px}}
 table{{border-collapse:collapse;width:100%;max-width:1000px;margin:8px 0 30px}}
 th,td{{text-align:left;padding:7px 10px;border-bottom:1px solid #1a1c24;font-size:13px;vertical-align:top}}
 th{{color:#c9a227;font-size:11px;letter-spacing:.06em;text-transform:uppercase}}
 td code{{color:#8a909c;font-size:11.5px}} tr.bad td{{background:#241414}}
 figure{{margin:0 0 26px}} figcaption{{color:#c9a227;font-size:12px;margin-bottom:7px}}
 img{{max-width:1000px;width:100%;border:1px solid #1e2029;border-radius:10px;display:block}}
</style>
<h1>Google Calendar — E2E test report</h1>
<div class="sub">Playwright / headless Chromium · mocked Google OAuth + Calendar · real redirect chain · screenshots embedded</div>
<p><span class="pill">{passed}/{len(results)} checks passed</span></p>
<table><tr><th>#</th><th>check</th><th></th><th>detail</th></tr>{rows}</table>
{figs}
"""
    out = REPO / "tasks" / "google-e2e-report.html"
    out.write_text(html)
    print(f"report -> {out.relative_to(REPO)}")


if __name__ == "__main__":
    main()
