#!/usr/bin/env python3
"""Hold Otter's push socket open and react the moment anything happens.

Otter's web client mints a short-lived ws JWT (GET forward/api/v1/get_jwt_token) and
connects wss://ws.aisense.com/api/v2/client/session_update?token=..&userid=.. — a single
authenticated socket that stays silent when idle and pushes a frame on session activity
(a meeting goes live, transcript grows). This holds that same socket: one connection, no
polling. Connecting is subscribing; no hello frame needed. The token expires, so each
reconnect refreshes it. A server-side close is transient (reconnect); anything else
(bad token, handshake refusal) propagates.

  python3 otter_watch.py
"""
from websocket import create_connection, WebSocketConnectionClosedException
from otter_session import open_session

WS = "wss://ws.aisense.com/api/v2/client/session_update"


def jwt(s):
    return s.get("https://otter.ai/forward/api/v1/get_jwt_token", timeout=30).json()["token"]


def on_event(msg):
    print(msg, flush=True)  # next: dispatch live-meeting frames into the decoder/recap


def main():
    s = open_session()
    while True:
        ws = create_connection(f"{WS}?token={jwt(s)}&userid={s.uid}",
                               timeout=30, header=["User-Agent: Mozilla/5.0"])
        ws.settimeout(None)  # idle socket is silent until activity — recv must block, not time out
        print(f"connected {WS}  userid={s.uid}", flush=True)
        try:
            while True:
                on_event(ws.recv())
        except WebSocketConnectionClosedException:
            print("socket closed; refreshing token and reconnecting", flush=True)
        finally:
            ws.close()


if __name__ == "__main__":
    main()
