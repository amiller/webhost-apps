"""Shared Otter session — one auth path for every tool here.

Provider selected by OTTER_SESSION:
  chrome (default) — reuse the Chrome otter.ai login via browser_cookie3 (local).
  sealed           — read OTTER_SESSIONID / OTTER_CSRFTOKEN from the env, the way a
                     TEE pod receives them as sealed secrets (no browser in the enclave).

Everything downstream is identical; only where the cookie comes from differs. That diff
is the whole audit surface between the local run and the hosted/pod run.
"""
import os
import requests

BASE = os.environ.get("OTTER_API_BASE", "https://otter.ai/forward/api/v1/")


def _cookies():
    mode = os.environ.get("OTTER_SESSION", "chrome")
    if mode == "chrome":
        import browser_cookie3 as bc
        jar = {c.name: c.value for c in bc.chrome(domain_name="otter.ai")}
        return {"sessionid": jar["sessionid"], "csrftoken": jar["csrftoken"]}
    if mode == "sealed":
        return {"sessionid": os.environ["OTTER_SESSIONID"], "csrftoken": os.environ["OTTER_CSRFTOKEN"]}
    raise ValueError(f"OTTER_SESSION must be chrome|sealed, got {mode!r}")


class _Oauth3Resp:
    def __init__(self, data): self._d = data
    def json(self): return self._d
    def raise_for_status(self): pass


def _iso_epoch(iso):
    if not iso: return 0
    import datetime
    try: return int(datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())
    except Exception: return 0


class _Oauth3Session:
    """Drop-in for the otter.ai requests.Session, but reads through an OAuth3
    instance with a scoped token — this app never holds the Otter cookie. Serves
    the *simple* surface only: list conversations + transcript text. Live frames,
    images, and speaker labels are not exposed over OAuth3 yet (those calls return
    empty, so the live-meeting / slide features degrade rather than break)."""
    def __init__(self, node, token):
        self.node = node.rstrip("/")   # the instance API base, e.g. https://<pod>/oauth3/api
        self.token = token
        self.uid = "oauth3"
        self.csrf = ""
        self.media = {}
        self.user = {"userid": "oauth3", "via": "oauth3"}

    def _data(self, path):
        r = requests.get(f"{self.node}{path}", headers={"Authorization": f"Bearer {self.token}"}, timeout=60)
        r.raise_for_status()
        return r.json()["data"]

    def get(self, url, params=None, timeout=None):
        u = url.rstrip("/")
        if u.endswith("speeches"):
            items = self._data("/otter/items")
            return _Oauth3Resp({"speeches": [
                {"otid": it["id"], "title": it.get("title") or "", "start_time": _iso_epoch(it.get("date")),
                 "live_status": None, "source": "owned"} for it in items]})
        if u.endswith("speech"):
            otid = (params or {}).get("otid")
            text = (self._data(f"/otter/items/{otid}") or {}).get("transcript") or ""
            segs = [{"order": 0, "uuid": "0", "label": 0, "transcript": text}] if text else []
            return _Oauth3Resp({"speech": {"otid": otid, "transcripts": segs, "images": []}})
        if u.endswith("user"):
            return _Oauth3Resp(self.user)
        raise ValueError(f"oauth3 session: unsupported otter call {url}")


def open_session(cookies=None):
    """Open a session. `cookies` (sessionid+csrftoken) lets a caller validate a specific
    user's login (e.g. onboarding a per-user cookie); None uses the env/chrome mode above,
    or the OAuth3 mode (OTTER_SESSION=oauth3) which reads through an instance with a token."""
    if cookies is None and os.environ.get("OTTER_SESSION") == "oauth3":
        return _Oauth3Session(os.environ["OAUTH3_NODE"], os.environ["OAUTH3_TOKEN"])
    c = cookies or _cookies()
    s = requests.Session()
    s.cookies.update(c)
    s.headers.update({"referer": "https://otter.ai/", "user-agent": "Mozilla/5.0"})
    s.user = s.get(BASE + "user", timeout=30).json()  # raises/KeyErrors if the cookie is dead
    s.uid = s.user["userid"]
    s.csrf = c["csrftoken"]
    s.media = c  # api.aisense.com assets need sessionid+csrftoken sent explicitly (cross-domain)
    return s
