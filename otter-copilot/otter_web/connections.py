"""The Connections panel's data: login state of each *mechanism* for the current user.

A status probe converts "logged out / cookie dead / not configured" into connected:false
(with the real error text in `error`, never hidden) so the panel can show onboarding —
that is the point of a probe, not a masked failure.

  otter   — per-user Otter cookie. owner uses the server's env/chrome session.
  google  — per-user Google OAuth (Calendar + Gemini notes). Wired in P3.
  vexa    — owner-only; owner self-hosts Vexa in the TEE. Locked for other users.
"""
import os
from otter_session import open_session
from otter_web import users, google_app


def _ident(user):
    return user.get("email") or user.get("name") or user.get("username") or str(user.get("userid"))


def otter_status(uid):
    try:
        if uid == "owner":
            u = open_session().user                       # env/chrome session this server runs on
        else:
            conn = users.load(uid).get("otter")
            if not conn:
                return {"connected": False}
            u = open_session({"sessionid": conn["sessionid"], "csrftoken": conn["csrftoken"]}).user
        return {"connected": True, "identity": _ident(u)}
    except Exception as e:
        return {"connected": False, "error": f"{type(e).__name__}: {e}"}


def google_status(uid):
    return google_app.status(uid)


def vexa_status(uid):
    if uid != "owner":
        return {"connected": False, "locked": True,
                "detail": "Owner-hosted in the TEE — not available to your account."}
    url = os.environ.get("VEXA_URL")
    if not url:
        return {"connected": False, "detail": "Set VEXA_URL to your TEE-hosted Vexa."}
    return {"connected": True, "identity": url, "detail": "self-hosted in TEE"}


def all_status(uid):
    return [
        {"id": "otter", "label": "Otter", "owner_only": False, **otter_status(uid)},
        {"id": "google", "label": "Google · Calendar + Gemini notes", "owner_only": False, **google_status(uid)},
        {"id": "vexa", "label": "Vexa", "owner_only": True, **vexa_status(uid)},
    ]
