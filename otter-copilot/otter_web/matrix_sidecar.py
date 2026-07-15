#!/usr/bin/env python3
"""Persistent E2EE Matrix sender — the sidecar matrix.py enqueues to.

Owns its OWN Matrix device. On first run it logs in with the bot password (minting a
fresh device_id + access_token) and persists them next to the crypto store on /data;
every later run restores that device. This is the whole ballgame for E2EE: one device ==
one crypto store == one running process. If a device_id is reused across two nio stores
(e.g. a laptop one-shot AND this CVM sidecar) each mints its own olm identity key, only
one can be the published device key, and the recipient cannot decrypt the other's megolm
sessions — exactly the 'cannot decrypt' symptom. So nothing else may run encryption as
this device; debug senders must log in their own (oneshot_send.py).

Tails the spool matrix.post() writes to: each *.json is room_send()'d to the ENCRYPTED
target room in timestamp order and deleted on success. A sync runs before sending (nio's
room_send raises 'No such room' until sync populates client.rooms) and between drains so
recipient device keys stay fresh for megolm key-sharing.

Env: MATRIX_HOMESERVER, MATRIX_ROOM (encrypted room id), MATRIX_USER, MATRIX_PASSWORD.
     MATRIX_STORE (crypto store dir), MATRIX_SPOOL (queue dir) — both default under /data.
Errors propagate; a send that returns an error response prints and the file is left in the
spool to retry on the next loop (no fallback, no silent drop).
"""
import asyncio, json, os
from pathlib import Path
from nio import AsyncClient, AsyncClientConfig, LoginError, RoomSendError

HS = os.environ["MATRIX_HOMESERVER"].rstrip("/")
ROOM = os.environ["MATRIX_ROOM"]
MXID = os.environ["MATRIX_USER"]
PASSWORD = os.environ["MATRIX_PASSWORD"]
ONDATA = os.path.isdir("/data")
STORE = Path(os.environ.get("MATRIX_STORE", "/data/nio_store" if ONDATA else
                            str(Path(__file__).parent / "nio_store")))
SPOOL = Path(os.environ.get("MATRIX_SPOOL", "/data/matrix_spool" if ONDATA else
                            str(Path(__file__).parent / "matrix_spool")))
CREDS = STORE / "device_creds.json"
POLL = float(os.environ.get("MATRIX_POLL", "2"))


async def login(client):
    """Restore this sidecar's own device, or mint one on first run and persist it."""
    if CREDS.exists():
        c = json.loads(CREDS.read_text())
        client.restore_login(user_id=c["user_id"], device_id=c["device_id"],
                             access_token=c["access_token"])
        client.load_store()
        return
    resp = await client.login(PASSWORD, device_name="otter-copilot-sidecar")
    if isinstance(resp, LoginError):
        raise SystemExit(f"[sidecar] login failed: {resp.message}")
    CREDS.write_text(json.dumps({"user_id": client.user_id, "device_id": client.device_id,
                                 "access_token": client.access_token}))


async def drain(client):
    for f in sorted(SPOOL.glob("*.json")):
        msg = json.loads(f.read_text())
        resp = await client.room_send(ROOM, "m.room.message", msg,
                                      ignore_unverified_devices=True)
        if isinstance(resp, RoomSendError):
            print(f"[sidecar] send failed for {f.name}: {resp.message}", flush=True)
            return  # leave it (and everything after) for the next loop; preserve order
        print(f"POSTED:{resp.event_id}  ({f.name})", flush=True)
        f.unlink()


async def main():
    STORE.mkdir(parents=True, exist_ok=True)
    SPOOL.mkdir(parents=True, exist_ok=True)
    client = AsyncClient(HS, MXID, store_path=str(STORE),
                         config=AsyncClientConfig(encryption_enabled=True, store_sync_tokens=True))
    await login(client)
    if client.should_upload_keys:
        await client.keys_upload()  # publish THIS device's identity before sending
    await client.sync(timeout=0, full_state=True)  # populate client.rooms + crypto state
    print(f"[sidecar] live as {client.user_id}/{client.device_id} -> {ROOM} "
          f"(encrypted={client.rooms[ROOM].encrypted})", flush=True)
    try:
        while True:
            await drain(client)
            await client.sync(timeout=int(POLL * 1000), full_state=False)
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
