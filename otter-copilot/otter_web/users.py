"""Per-user identity + connection store for the optionally-multi-user instance.

A "user" is whoever is driving a browser session: the OWNER (holds OWNER_TOKEN) or a
visitor who minted a random user token on first connect. uid = "owner" for the owner,
else "u_<sha256(token)[:12]>". Each user's connected mechanisms (Otter cookie, Google
token, chosen transcript source) live at DATA/users/<uid>/connections.json.

Prototype: stored as plaintext on the /data volume (TEE-sealed at the volume level, not
field-encrypted). Errors propagate.
"""
import hashlib, hmac, json, os
from pathlib import Path

DATA = Path(os.environ.get("OTTER_OUT", "/data/otter" if os.path.isdir("/data") else str(Path(__file__).parent / "data")))
USERS_DIR = DATA / "users"


def uid_for(token, owner_token):
    """owner if token is the owner token, else a stable hashed uid, else None (no identity)."""
    if not token:
        return None
    if owner_token and hmac.compare_digest(token, owner_token):
        return "owner"
    return "u_" + hashlib.sha256(token.encode()).hexdigest()[:12]


def _path(uid):
    return USERS_DIR / uid / "connections.json"


def load(uid):
    p = _path(uid)
    return json.loads(p.read_text()) if p.exists() else {}


def save(uid, conns):
    p = _path(uid)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(conns))
    tmp.rename(p)


def set_mech(uid, mech, value):
    c = load(uid)
    c[mech] = value
    save(uid, c)
    return c
