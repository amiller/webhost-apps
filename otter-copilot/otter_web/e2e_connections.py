#!/usr/bin/env python3
"""End-to-end browser tests for the Connections panel + Otter onboarding (P1/P2).

Boots a mock Otter API (so onboarding/owner-status validate deterministically, no real
otter.ai cookie) + the real app server, then drives Chromium through:
  1. guest    — panel shows Otter/Google not-connected, Vexa locked (owner-tagged)
  2. onboard  — "connect Otter" expands the extension + script + personalized-URL instructions
  3. connect  — POST the cookie the way the extension does → panel flips Otter to connected
  4. owner    — owner sees Otter connected (server session) + Vexa unlocked/connected

Captures a screenshot per scenario and writes tasks/connections-e2e-report.md.

  python3 otter_web/e2e_connections.py
"""
import base64, json, os, socket, subprocess, sys, tempfile, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = REPO / "tasks" / "e2e"
EMAIL = "demo@otter.ai"


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class MockOtter(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith("/user"):
            body = {"userid": 7, "email": EMAIL}
        elif self.path.startswith("/speeches"):
            body = {"speeches": []}
        else:
            body = {}
        b = json.dumps(body).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)


def wait_up(url, tries=50):
    for _ in range(tries):
        try:
            urlopen(url, timeout=1); return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"server never came up: {url}")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    mock_port, app_port = free_port(), free_port()
    api_base = f"http://127.0.0.1:{mock_port}/"

    mock = ThreadingHTTPServer(("127.0.0.1", mock_port), MockOtter)
    Thread(target=mock.serve_forever, daemon=True).start()

    env = dict(os.environ, NEAR_KEY="dummy", OWNER_TOKEN="OWN", OTTER_API_BASE=api_base,
               OTTER_SESSION="sealed", OTTER_SESSIONID="srv-sess", OTTER_CSRFTOKEN="srv-csrf",
               VEXA_URL="https://vexa.tee.local", OTTER_OUT=tempfile.mkdtemp(prefix="otter-e2e-"),
               PORT=str(app_port), HOST="127.0.0.1")
    app = subprocess.Popen([sys.executable, "server.py"], cwd=str(HERE), env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{app_port}/"
    results = []

    def check(name, cond, detail=""):
        results.append((name, bool(cond), detail))
        print(("  PASS " if cond else "  FAIL ") + name + (f" — {detail}" if detail else ""))

    def cards(page):
        return page.evaluate("""() => [...document.querySelectorAll('#connections .conn')].map(c => ({
            cls: c.className.trim(), name: c.querySelector('.name')?.textContent || '',
            who: c.querySelector('.who')?.textContent || '', tag: c.querySelector('.tag')?.textContent || '',
            err: c.querySelector('.err')?.textContent || '' }))""")

    try:
        wait_up(base)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)

            # ---- scenarios 1-3: a guest/user context ----
            ctx = browser.new_context(viewport={"width": 1100, "height": 900})
            page = ctx.new_page()
            page.goto(base); page.wait_for_selector("#connections .conn")
            c = {x["name"].lower().split()[0]: x for x in cards(page)}
            on = lambda card: "on" in card["cls"].split()
            check("guest: 3 mechanism cards", len(c) == 3, f"got {list(c)}")
            check("guest: Otter not connected", not on(c["otter"]) and "not connected" in c["otter"]["who"])
            check("guest: Google not connected", not on(c["google"]))
            check("guest: Vexa locked + owner tag", "locked" in c["vexa"]["cls"].split() and c["vexa"]["tag"] == "owner",
                  c["vexa"]["who"])
            page.screenshot(path=str(OUT / "01-guest-panel.png"), full_page=True)

            page.click('[data-ob="ob-otter"]'); page.wait_for_selector("#ob-otter.show")
            ob = page.text_content("#ob-otter").lower()  # text_content = raw (no CSS text-transform)
            check("onboard: extension instructions shown", "otter pilot extension" in ob)
            check("onboard: personalized URL shown", "/onboard/otter?u=" in ob)
            check("onboard: capture script shown", "onboard_otter.py" in ob)
            page.screenshot(path=str(OUT / "02-otter-onboard.png"), full_page=True)

            tok = page.evaluate("() => localStorage.getItem('otter_user_token')")
            resp = page.evaluate("""async (u) => {
                const r = await fetch('/onboard/otter?u=' + encodeURIComponent(u),
                  {method:'POST', headers:{'content-type':'application/json'},
                   body: JSON.stringify({sessionid:'user-sess', csrftoken:'user-csrf'})});
                return await r.json(); }""", tok)
            check("onboard POST returns connected", resp.get("connected") is True and resp.get("identity") == EMAIL,
                  json.dumps(resp))
            page.reload(); page.wait_for_selector("#connections .conn")
            c = {x["name"].lower().split()[0]: x for x in cards(page)}
            check("after onboard: Otter card connected", on(c["otter"]) and EMAIL in c["otter"]["who"],
                  c["otter"]["who"])
            page.screenshot(path=str(OUT / "03-otter-connected.png"), full_page=True)
            ctx.close()

            # ---- scenario 4: owner context ----
            octx = browser.new_context(viewport={"width": 1100, "height": 900})
            opage = octx.new_page()
            opage.goto(base + "#owner=OWN"); opage.wait_for_selector("#connections .conn")
            c = {x["name"].lower().split()[0]: x for x in cards(opage)}
            check("owner: Otter connected (server session)", on(c["otter"]) and EMAIL in c["otter"]["who"],
                  c["otter"]["who"])
            check("owner: Vexa unlocked + connected", "locked" not in c["vexa"]["cls"].split() and on(c["vexa"]),
                  c["vexa"]["who"])
            opage.screenshot(path=str(OUT / "04-owner-panel.png"), full_page=True)
            octx.close()
            browser.close()
    finally:
        app.terminate()
        try: app.wait(timeout=5)
        except Exception: app.kill()
        mock.shutdown()

    write_report(results)
    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


def write_report(results):
    shots = [("01-guest-panel.png", "Guest — Otter/Google not connected, Vexa locked (owner-only)"),
             ("02-otter-onboard.png", "Connect Otter — extension + script + personalized URL"),
             ("03-otter-connected.png", "After onboarding — Otter card flips to connected"),
             ("04-owner-panel.png", "Owner — Otter connected (server session) + Vexa unlocked")]
    passed = sum(1 for _, ok, _ in results if ok)
    esc = lambda s: (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    rows = "".join(
        f'<tr class="{"ok" if ok else "bad"}"><td>{i}</td><td>{esc(name)}</td>'
        f'<td>{"✅" if ok else "❌"}</td><td><code>{esc(detail.replace(chr(10)," ")[:120])}</code></td></tr>'
        for i, (name, ok, detail) in enumerate(results, 1))

    figs = ""
    for fn, cap in shots:
        b64 = base64.b64encode((OUT / fn).read_bytes()).decode()
        figs += f'<figure><figcaption>{esc(cap)}</figcaption><img src="data:image/png;base64,{b64}"></figure>'

    html = f"""<!doctype html><meta charset=utf-8><title>Connections panel — E2E report</title>
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
<h1>Connections panel — E2E test report</h1>
<div class="sub">Playwright / headless Chromium · mock Otter API + real app server · self-contained (screenshots embedded)</div>
<p><span class="pill">{passed}/{len(results)} checks passed</span></p>
<h2 style="font-size:14px;color:#cdd2da">Checks</h2>
<table><tr><th>#</th><th>check</th><th></th><th>detail</th></tr>{rows}</table>
<h2 style="font-size:14px;color:#cdd2da">Screenshots</h2>
{figs}
"""
    out = REPO / "tasks" / "connections-e2e-report.html"
    out.write_text(html)
    print(f"report -> {out.relative_to(REPO)}")


if __name__ == "__main__":
    main()
