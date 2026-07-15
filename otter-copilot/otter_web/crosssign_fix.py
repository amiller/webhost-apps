#!/usr/bin/env python3
"""Clear the copilot bot's RED "not signed by master key" shield.

WHY THIS EXISTS: the bot's original cross-signing run published an SSK but the
SSK *private* key was never persisted (and the bot password wasn't either), so
the published SSK cannot sign the device. The device key itself had also never
been uploaded. The missing device key is now uploaded (non-destructive). The
only remaining path is to publish a FRESH master/SSK/USK identity and sign the
device with the new SSK.

DESTRUCTIVE: this OVERWRITES the bot's published cross-signing identity
(master/SSK/USK) on the homeserver. Any prior verification of the OLD master key
is invalidated. Currently nobody has cross-verified the bot (only a red shield
shows), so this is safe — but run it knowingly.

No password needed: this homeserver (continuwuity) currently accepts
/keys/device_signing/upload without UIA (verified empty-body -> 200). If it ever
returns 401, pass the bot password as argv[2].

Run:  MATRIX_TOKEN=... python3 crosssign_fix.py [optional_password]
Persists the new private_keys to ./copilot_crosssign_private_keys.json — KEEP IT.
"""
import sys, os, json, base64, asyncio, pathlib, urllib.request, urllib.error
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization
from nio import AsyncClient, AsyncClientConfig

HS = os.environ.get("MATRIX_HOMESERVER", "https://mtrx.shaperotator.xyz").rstrip("/")
UID = "@otter-copilot-bot:mtrx.shaperotator.xyz"
DEV = "nbrXNLiTeG"
TOK = os.environ["MATRIX_TOKEN"]
PW = sys.argv[1] if len(sys.argv) > 1 else ""
H = {"Authorization": "Bearer " + TOK, "Content-Type": "application/json"}

b64 = lambda b: base64.b64encode(b).rstrip(b"=").decode()
canon = lambda o: json.dumps(o, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode()
rawpub = lambda k: k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
rawpriv = lambda k: k.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())


def post(path, body):
    req = urllib.request.Request(HS + path, data=json.dumps(body).encode(), headers=H)
    try:
        r = urllib.request.urlopen(req); return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def sign(obj, signer, kid):
    ts = {k: v for k, v in obj.items() if k not in ("signatures", "unsigned")}
    sigs = dict(obj.get("signatures", {})); us = dict(sigs.get(UID, {}))
    us[f"ed25519:{kid}"] = b64(signer.sign(canon(ts)))
    sigs[UID] = us; obj["signatures"] = sigs; return obj


async def ensure_device_keys():
    """Make sure the device's E2EE keys are on the server (idempotent)."""
    store = "/data/nio_store" if os.path.isdir("/data") else str(pathlib.Path(__file__).parent / "nio_store")
    pathlib.Path(store).mkdir(parents=True, exist_ok=True)
    c = AsyncClient(HS, UID, device_id=DEV, store_path=store,
                    config=AsyncClientConfig(encryption_enabled=True, store_sync_tokens=True))
    c.restore_login(user_id=UID, device_id=DEV, access_token=TOK)
    c.load_store()
    if c.should_upload_keys:
        await c.keys_upload()
    await c.close()


def main():
    asyncio.run(ensure_device_keys())
    msk, ssk, usk = (ed25519.Ed25519PrivateKey.generate() for _ in range(3))
    mp, sp, up = b64(rawpub(msk)), b64(rawpub(ssk)), b64(rawpub(usk))
    master = sign({"user_id": UID, "usage": ["master"], "keys": {f"ed25519:{mp}": mp}}, msk, mp)
    selfk = sign({"user_id": UID, "usage": ["self_signing"], "keys": {f"ed25519:{sp}": sp}}, msk, mp)
    userk = sign({"user_id": UID, "usage": ["user_signing"], "keys": {f"ed25519:{up}": up}}, msk, mp)
    body = {"master_key": master, "self_signing_key": selfk, "user_signing_key": userk}
    st, resp = post("/_matrix/client/v3/keys/device_signing/upload", body)
    if st == 401:
        if not PW:
            raise SystemExit("homeserver requires UIA; pass the bot password as argv[1]")
        body["auth"] = {"type": "m.login.password",
                        "identifier": {"type": "m.id.user", "user": UID},
                        "password": PW, "session": resp["session"]}
        st, resp = post("/_matrix/client/v3/keys/device_signing/upload", body)
    if st != 200:
        raise SystemExit(f"device_signing/upload failed {st}: {resp}")

    st, q = post("/_matrix/client/v3/keys/query", {"device_keys": {UID: [DEV]}})
    dobj = q["device_keys"][UID][DEV]
    st, resp = post("/_matrix/client/v3/keys/signatures/upload", {UID: {DEV: sign(dobj, ssk, sp)}})
    ok = st == 200 and not resp.get("failures")
    pk = {"master": b64(rawpriv(msk)), "self_signing": b64(rawpriv(ssk)), "user_signing": b64(rawpriv(usk)),
          "msk_public": mp, "ssk_public": sp, "usk_public": up}
    out = pathlib.Path(__file__).parent / "copilot_crosssign_private_keys.json"
    out.write_text(json.dumps(pk, indent=2))
    print(f"device_signed={ok}  new_msk={mp}  new_ssk={sp}")
    print(f"private_keys persisted -> {out}  (KEEP SAFE; do not commit)")


if __name__ == "__main__":
    main()
