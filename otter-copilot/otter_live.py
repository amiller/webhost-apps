#!/usr/bin/env python3
"""Follow (tail) a live Otter meeting in real time by polling get_speech.

Otter's REST endpoints return the transcript-so-far for an in-progress meeting and
it grows as Otter transcribes. This finds the meeting with live_status=='live' and
prints new segments as they appear. (For sub-second push you'd use the speech_start
-> wss://ws.aisense.com stream; polling is simpler and good enough to follow along.)

Diarization note: live speaker labels are provisional cluster ids (Otter re-clusters
as it hears more); clean speaker names settle after the meeting finishes.

Usage:
  python3 otter_live.py                 # follow the current live meeting
  python3 otter_live.py --interval 8    # poll every N seconds (default 12)
  python3 otter_live.py --otid <otid>   # follow a specific meeting
"""
import argparse, time
from otter_session import open_session

BASE = "https://otter.ai/forward/api/v1/"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=int, default=12)
    ap.add_argument("--otid", default=None)
    ap.add_argument("--duration", type=int, default=0, help="stop after N seconds (0=until meeting ends)")
    args = ap.parse_args()

    s = open_session()
    uid = s.uid

    otid = args.otid
    if not otid:
        speeches = s.get(BASE + "speeches",
                         params={"userid": uid, "page_size": 20, "source": "owned"}, timeout=40).json()["speeches"]
        live = [x for x in speeches if x.get("live_status") == "live"]
        if not live:
            print("No live meeting right now (no speech with live_status='live').")
            return
        otid = live[0]["otid"]
        print(f"following live: {live[0].get('title')!r}  ({otid})")

    seen = set()
    started = time.time()
    while True:
        d = s.get(BASE + "speech", params={"userid": uid, "otid": otid}, timeout=30).json()["speech"]
        for seg in sorted(d.get("transcripts") or [], key=lambda x: x.get("order") or 0):
            if seg["uuid"] in seen:
                continue
            seen.add(seg["uuid"])
            spk = seg.get("label")
            txt = (seg.get("transcript") or "").strip()
            if txt:
                print(f"[S{spk}] {txt}", flush=True)
        if d.get("live_status") != "live" or d.get("process_finished"):
            print("--- meeting ended ---")
            return
        if args.duration and time.time() - started > args.duration:
            print("--- stopped (duration) ---")
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
