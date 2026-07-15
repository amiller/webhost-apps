"""Post messages to a Matrix room — the one outbound-to-Matrix path.

The target room is END-TO-END ENCRYPTED, so posts cannot go over plain HTTP — the
server rejects unencrypted events in an encrypted room. Encryption needs a long-lived
nio client with a persistent crypto store (megolm sessions, peer device keys), which is
async and stateful; the synchronous server can't host it. So post() just *enqueues*: it
drops one JSON file into a spool dir, and a sidecar (matrix_sidecar.py) — the persistent
E2EE nio client — picks each up in order and room_send()s it, deleting on success. The
spool dir lives on the persistent /data volume, so messages survive a restart of either
side and ordering is preserved.

Creds from env: MATRIX_HOMESERVER, MATRIX_ROOM (the ENCRYPTED room id), MATRIX_USER,
MATRIX_PASSWORD (the sidecar logs in with these and owns its own device). With those set
it enqueues; with any missing it runs dry-run and just logs — the replay self-test
exercises the full call path with no creds. Errors propagate (a full disk raises, not swallowed).
"""
import json, os, time
from pathlib import Path

HS = os.environ.get("MATRIX_HOMESERVER")
ROOM = os.environ.get("MATRIX_ROOM")
# The sidecar logs in with MATRIX_PASSWORD and owns its own device; enqueue iff it can send.
LIVE = bool(HS and ROOM and os.environ.get("MATRIX_PASSWORD"))

SPOOL = Path(os.environ.get("MATRIX_SPOOL", "/data/matrix_spool" if os.path.isdir("/data") else
                            str(Path(__file__).parent / "matrix_spool")))


def post(body, html=None):
    if not LIVE:
        print(f"[matrix dry-run] {body}", flush=True)
        return
    SPOOL.mkdir(parents=True, exist_ok=True)
    msg = {"msgtype": "m.notice", "body": body}
    if html:
        msg.update({"format": "org.matrix.custom.html", "formatted_body": html})
    # monotonic, sortable, unique filename; .tmp+rename so the sidecar never reads a partial write
    name = f"{time.time_ns()}.json"
    tmp = SPOOL / (name + ".tmp")
    tmp.write_text(json.dumps(msg))
    tmp.rename(SPOOL / name)
