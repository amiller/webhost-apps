#!/bin/bash
# One-shot: seal your YouTube cookies into the pod vault, mint a scoped youtube token,
# and redeploy feedling-web with it. Run in YOUR session:  ! bash ~/projects/teleport/feedling-web/sync-youtube.sh
# Prints only counts/status — never cookie values or the raw token.
set -euo pipefail
POD="https://pod.dstack.soc1024.com"
PROFILE="$HOME/.config/google-chrome/Default"
ENVF="$HOME/projects/hermes-agent/deploy-notes/.env.prod9"
OWNER=$(grep -E '^OAUTH3_OWNER_SECRET=' "$ENVF" | cut -d= -f2-)
DAEMON=$(grep -E '^TEE_DAEMON_TOKEN=' "$ENVF" | cut -d= -f2-)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cp "$PROFILE/Cookies" "$TMP/c.db"

# --- decrypt the essential youtube jar to a temp file (values never hit stdout/argv) ---
python3 - "$TMP/c.db" "$TMP/jar.json" <<'PY'
import sqlite3, hashlib, sys, json, string, secretstorage
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
db, out = sys.argv[1], sys.argv[2]
def pw():
    bus = secretstorage.dbus_init(); col = secretstorage.get_default_collection(bus)
    for i in col.get_all_items():
        if i.get_label() == "Chrome Safe Storage":
            return i.get_secret()
    return b"peanuts"
P = pw(); printable = set(string.printable.encode())
con = sqlite3.connect(db); con.text_factory = bytes
rows = con.execute("select name,encrypted_value,host_key from cookies "
                   "where host_key like '%youtube.com' or host_key like '%google.com'").fetchall()
def valid(b): return len(b) > 0 and all(c in printable for c in b)
# auto-detect (iters, strip) using a known auth cookie
sample = next(ev for n, ev, h in rows if n == b'LOGIN_INFO')
chosen = None
for iters in (1, 1003):
    key = hashlib.pbkdf2_hmac("sha1", P, b"saltysalt", iters, 16)  # Chrome/Linux uses HMAC-SHA1
    for strip in (0, 32):
        try:
            d = Cipher(algorithms.AES(key), modes.CBC(b" " * 16), default_backend()).decryptor()
            dec = d.update(sample[3:]) + d.finalize(); body = dec[:-dec[-1]][strip:]
            if valid(body): chosen = (key, strip); break
        except Exception: pass
    if chosen: break
assert chosen, "could not decrypt Chrome cookies (unexpected version)"
key, strip = chosen
def dec1(ev):
    if ev[:3] not in (b'v10', b'v11'): return ev.decode('utf-8', 'replace')
    d = Cipher(algorithms.AES(key), modes.CBC(b" " * 16), default_backend()).decryptor()
    o = d.update(ev[3:]) + d.finalize(); return o[:-o[-1]][strip:].decode('utf-8', 'replace')
ESSENTIAL = {"SID","HSID","SSID","APISID","SAPISID","__Secure-1PSID","__Secure-3PSID",
 "__Secure-1PAPISID","__Secure-3PAPISID","__Secure-1PSIDTS","__Secure-3PSIDTS",
 "__Secure-1PSIDCC","__Secure-3PSIDCC","SIDCC","LOGIN_INFO","PREF",
 "VISITOR_INFO1_LIVE","YSC","VISITOR_PRIVACY_METADATA"}
jar = {}
# prefer the youtube.com copy of each name over the google.com one
for want_host in ("youtube.com", "google.com"):
    for n, ev, h in rows:
        n = n.decode()
        if n in ESSENTIAL and n not in jar and want_host in h.decode():
            v = dec1(ev)
            if v: jar[n] = v
json.dump(jar, open(out, "w"))
print(f"decrypted {len(jar)} essential youtube cookies")
PY

# --- seal into the vault (owner subject) ---
python3 -c "import json,sys;print(json.dumps({'plugin':'youtube','cookies':json.load(open('$TMP/jar.json'))}))" > "$TMP/upload.json"
echo -n "vault seal: "
curl -s -X POST "$POD/oauth3/api/cookies" -H "Authorization: Bearer $OWNER" \
  -H "Content-Type: application/json" --data @"$TMP/upload.json" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('sealed' if d.get('ok') else d)"

# --- mint a scoped youtube token (value written to file, not printed) ---
curl -s -X POST "$POD/oauth3/api/tokens" -H "Authorization: Bearer $OWNER" \
  -H "Content-Type: application/json" -d '{"plugin":"youtube","app":"feedling"}' \
  | python3 -c "import sys,json;open('$TMP/tok','w').write(json.load(sys.stdin)['token'])"
echo "minted youtube token"

# --- redeploy feedling-web with the token ---
cd "$HOME/projects/teleport/feedling-web"
src(){ grep -E "^$1=" .env | cut -d= -f2-; }
TB=$(mktemp --suffix=.tgz)
tar czf "$TB" --exclude='./.git' --exclude='./node_modules' --exclude='./.env' --exclude='./subs.json' --exclude='./sync-youtube.sh' -C . .
TOKEN=$(cat "$TMP/tok") VS="$(src VAPID_SUBJECT)" VPUB="$(src VAPID_PUBLIC_KEY)" VPRIV="$(src VAPID_PRIVATE_KEY)" ORK="$(src OPENROUTER_API_KEY)" DM="$(src DIARY_MODEL)" \
python3 - > "$TMP/manifest.json" <<'PY'
import json, os
print(json.dumps({"name":"feedling-web","runtime":"deno","entry":"server.ts","isolation":"container",
 "oci_runtime":"runc","mode":"dev","port":3000,"listen":{"port":8080,"protocol":"http"},
 "env":{"OAUTH3_NODE":"https://pod.dstack.soc1024.com/oauth3","OAUTH3_TOKEN":os.environ["TOKEN"],
        "BASE_PATH":"/feedling-web","POLL_MS":"300000","SUBS_FILE":"./subs.json",
        "VAPID_SUBJECT":os.environ["VS"],"VAPID_PUBLIC_KEY":os.environ["VPUB"],
        "VAPID_PRIVATE_KEY":os.environ["VPRIV"],"OPENROUTER_API_KEY":os.environ["ORK"],
        "DIARY_MODEL":os.environ["DM"]}}))
PY
echo -n "feedling redeploy: "
curl -sf -X POST -H "Authorization: Bearer $DAEMON" \
  -F "manifest=@$TMP/manifest.json;type=application/json" \
  -F "files=@$TB;type=application/gzip" "$POD/_api/projects" -o /dev/null && echo "ok"
rm -f "$TB"

# --- verify: poll and show the real result ---
sleep 12
curl -s -X POST "$POD/feedling-web/api/poll-now" >/dev/null || true
curl -s "$POD/feedling-web/api/state" | python3 -c "
import sys,json; d=json.load(sys.stdin)
p=d.get('poll') or {}; s=d.get('state') or {}
print('poll error:', p.get('error') or '(none — success!)')
print('shorts today:', s.get('shortsToday'), '| energy:', s.get('energy'))
"
