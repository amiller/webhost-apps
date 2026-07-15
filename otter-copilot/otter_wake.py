#!/usr/bin/env python3
"""Wake loop: run the meeting brain even when no one has the dashboard open.

server.py's /graph endpoint finds the live meeting, decodes new transcript, and posts
decisions/good-points to Matrix — but only when something polls it (the dashboard does, at
8s). This is that poll without the dashboard: nudge /graph slowly while idle, fast while a
meeting is live. So "open Otter -> the agent wakes and starts working" happens headlessly.

Pure HTTP client of the local server — it holds no Otter session itself, so it stays out of
the decode/Matrix code entirely. Errors propagate (a dead server crashes the loop, by design).

  python3 otter_wake.py
"""
import os, time, requests

GRAPH = os.environ.get("GRAPH_URL", f"http://127.0.0.1:{os.environ.get('PORT', 8137)}/graph")
IDLE = int(os.environ.get("WAKE_IDLE", 45))   # look for a live meeting this often when idle
LIVE = int(os.environ.get("WAKE_LIVE", 6))    # drive the decoder this often during a meeting
# /graph is owner-gated when OWNER_TOKEN is set; authenticate as owner so the headless driver works
HEADERS = {"X-Auth-Token": os.environ["OWNER_TOKEN"]} if os.environ.get("OWNER_TOKEN") else {}


def main():
    awake = False
    while True:
        g = requests.get(GRAPH, headers=HEADERS, timeout=60).json()
        if g.get("error"):
            print("graph error:", g["error"], flush=True)
        if g.get("live"):
            if not awake:
                print(f"awake: {g.get('title')!r} is live — driving decoder/Matrix", flush=True)
                awake = True
            time.sleep(LIVE)
        else:
            if awake:
                print("meeting ended; back to idle watch", flush=True)
                awake = False
            time.sleep(IDLE)


if __name__ == "__main__":
    main()
