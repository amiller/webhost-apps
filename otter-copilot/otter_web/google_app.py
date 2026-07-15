"""Per-user Google connection: Calendar (read-only). Hand-rolled over requests — no google libs.

Two ways a user is connected, mirroring the Otter pattern (owner reuses an existing session;
others onboard fresh):
  owner   — point GOOGLE_TOKEN_FILE at an existing authorized-user json (the same file the
            standalone calendar tool already created). The app reads + refreshes it IN PLACE;
            no re-consent, nothing copied.
  others  — per-user OAuth web flow (/google/auth → /google/callback), token stored per uid.

Identity is the primary calendar's id (== the account email), so only calendar.readonly is
required — no extra userinfo scope. External URLs are env-overridable (test seam).

Config:
  GOOGLE_TOKEN_FILE / GOOGLE_TOKEN_JSON   — owner's existing authorized-user json, by path or inline (optional).
  GOOGLE_CLIENT_ID / _SECRET / _REDIRECT_URI — OAuth web client for the per-user flow (optional).
"""
import json, os, time
from pathlib import Path
from urllib.parse import urlencode
import requests
from otter_web import users

CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")
REDIRECT_URI = os.environ.get("GOOGLE_REDIRECT_URI")
TOKEN_FILE = os.environ.get("GOOGLE_TOKEN_FILE")
TOKEN_JSON = os.environ.get("GOOGLE_TOKEN_JSON")  # inline authorized-user json (TEE deploy: no file to mount)
SCOPES = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly"

AUTH = os.environ.get("GOOGLE_OAUTH_AUTH", "https://accounts.google.com/o/oauth2/v2/auth")
TOKEN = os.environ.get("GOOGLE_OAUTH_TOKEN", "https://oauth2.googleapis.com/token")
CAL = os.environ.get("GOOGLE_CALENDAR", "https://www.googleapis.com/calendar/v3/calendars/primary/events")
CAL_PRIMARY = os.environ.get("GOOGLE_CAL_PRIMARY", "https://www.googleapis.com/calendar/v3/calendars/primary")
DRIVE = os.environ.get("GOOGLE_DRIVE", "https://www.googleapis.com/drive/v3/files")


def oauth_configured():
    return bool(CLIENT_ID and CLIENT_SECRET and REDIRECT_URI)


def owner_file():
    return bool(TOKEN_JSON or (TOKEN_FILE and Path(TOKEN_FILE).exists()))


def _owner_creds():
    return json.loads(TOKEN_JSON) if TOKEN_JSON else json.loads(Path(TOKEN_FILE).read_text())


def _refresh(client_id, client_secret, refresh_token, token_uri=None):
    r = requests.post(token_uri or TOKEN, timeout=30, data={
        "client_id": client_id, "client_secret": client_secret,
        "refresh_token": refresh_token, "grant_type": "refresh_token"})
    r.raise_for_status(); t = r.json()
    return t["access_token"], t.get("expires_in", 3600)


_CACHE = {}  # uid -> (access_token, expires_at)


def _access(uid):
    now = time.time()
    c = _CACHE.get(uid)
    if c and now < c[1]:
        return c[0]
    if uid == "owner" and owner_file():
        d = _owner_creds()  # standard authorized-user json (env or file)
        access, ttl = _refresh(d["client_id"], d["client_secret"], d["refresh_token"], d.get("token_uri"))
    else:
        g = users.load(uid).get("google")
        if not g:
            raise RuntimeError("google not connected")
        access, ttl = _refresh(g["client_id"], g["client_secret"], g["refresh_token"])
    _CACHE[uid] = (access, now + ttl - 60)
    return access


def _identity(access):
    r = requests.get(CAL_PRIMARY, headers={"Authorization": f"Bearer {access}"}, timeout=30)
    r.raise_for_status(); return r.json().get("id")  # primary calendar id == account email


def identity(uid):
    return _identity(_access(uid))


def status(uid):
    if uid == "owner" and owner_file():
        try:
            return {"connected": True, "identity": identity("owner")}
        except Exception as e:
            return {"connected": False, "error": f"{type(e).__name__}: {e}"}
    g = users.load(uid).get("google") or {}
    if g.get("identity"):
        return {"connected": True, "identity": g["identity"]}
    if not oauth_configured():
        return {"connected": False, "detail": "Set GOOGLE_TOKEN_FILE or GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI."}
    return {"connected": False}


def auth_url(state):
    return AUTH + "?" + urlencode({
        "client_id": CLIENT_ID, "redirect_uri": REDIRECT_URI, "response_type": "code",
        "scope": SCOPES, "access_type": "offline", "prompt": "consent",
        "include_granted_scopes": "true", "state": state})


def connect(uid, code):
    """Per-user OAuth callback: exchange the code, store refresh token + client creds + identity."""
    r = requests.post(TOKEN, timeout=30, data={
        "code": code, "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
        "redirect_uri": REDIRECT_URI, "grant_type": "authorization_code"})
    r.raise_for_status(); tok = r.json()
    g = {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
         "refresh_token": tok.get("refresh_token"), "identity": _identity(tok["access_token"])}
    users.set_mech(uid, "google", g)
    _CACHE.pop(uid, None)
    return g


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def _list_events(uid, time_min, time_max, max_results):
    r = requests.get(CAL, headers={"Authorization": f"Bearer {_access(uid)}"}, timeout=30,
                     params={"timeMin": time_min, "timeMax": time_max, "singleEvents": "true",
                             "orderBy": "startTime", "maxResults": max_results})
    r.raise_for_status()
    return r.json().get("items", [])


def events(uid, max_results=10):
    """Upcoming events (next 24h), soonest first — the copilot's 'what meeting is next' view."""
    now = time.time()
    out = []
    for e in _list_events(uid, _iso(now), _iso(now + 86400), max_results):
        s, en = e.get("start", {}), e.get("end", {})
        out.append({"summary": e.get("summary", "(no title)"),
                    "start": s.get("dateTime") or s.get("date"),
                    "end": en.get("dateTime") or en.get("date"),
                    "hangout": e.get("hangoutLink"), "location": e.get("location")})
    return out


def gemini_notes(uid, days=30, max_results=100):
    """Past events that carry a 'Notes by Gemini' attachment — importable meeting notes.
    Deduped by fileId (recurring meetings reuse the same notes doc)."""
    now = time.time()
    out, seen = [], set()
    for e in _list_events(uid, _iso(now - days * 86400), _iso(now), max_results):
        for att in e.get("attachments", []):
            fid = att.get("fileId")
            if att.get("title") == "Notes by Gemini" and fid and fid not in seen:
                seen.add(fid)
                s = e.get("start", {})
                out.append({"file_id": fid, "title": e.get("summary", "(no title)"),
                            "date": (s.get("dateTime") or s.get("date") or "")[:10]})
    return out


def gemini_text(uid, file_id):
    """Export a Gemini-notes Google Doc as plain text (Drive export)."""
    r = requests.get(f"{DRIVE}/{file_id}/export", headers={"Authorization": f"Bearer {_access(uid)}"},
                     params={"mimeType": "text/plain"}, timeout=30)
    r.raise_for_status()
    return r.text
