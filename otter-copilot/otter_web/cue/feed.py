#!/usr/bin/env python3
"""Feed a transcript into the cue server as transcript.segment observations (mock Otter).

Drives ~/projects/cue/examples/otter-live/server.config.ts end-to-end without a live
meeting. Sends each segment with its real timestamp (seconds), so IntervalCue fires by
meeting-time; ends with a `manual` observation to trigger the recap program. Prints the
actions each observation produced (decoder graph.nodes / consolidate / recap).

  python3 otter_web/cue/feed.py TRANSCRIPT.txt --max 20
  (cue server must be running on --url; NEAR_KEY in the server's env)
"""
import argparse, json, re, urllib.request
from pathlib import Path

HEAD = re.compile(r"^(?P<spk>.+?)\s{2,}(?P<ts>\d{1,2}:\d{2}(?::\d{2})?)\s*$")


def secs(ts):
    p = [int(x) for x in ts.split(":")]
    return p[0] * 60 + p[1] if len(p) == 2 else p[0] * 3600 + p[1] * 60 + p[2]


def parse(path):
    segs, cur = [], None
    for line in Path(path).read_text().splitlines():
        m = HEAD.match(line)
        if m:
            cur = {"speaker": m.group("spk").strip(), "t": secs(m.group("ts")), "text": ""}
            segs.append(cur)
        elif cur is not None and line.strip():
            cur["text"] = (cur["text"] + " " + line.strip()).strip()
    return [s for s in segs if s["text"]]


def post(url, obs):
    req = urllib.request.Request(url, data=json.dumps(obs).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        body = json.loads(r.read())
    return [a for res in body.get("results", []) for tr in res.get("toolResults", []) for a in tr.get("actions", [])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--url", default="http://localhost:8139")
    ap.add_argument("--session", default="replay")
    ap.add_argument("--max", type=int, default=20)
    args = ap.parse_args()

    segs = parse(args.file)[: args.max or None]
    ep = f"{args.url}/sessions/{args.session}/observations"
    print(f"feeding {len(segs)} segments -> {ep}\n")

    for i, s in enumerate(segs):
        acts = post(ep, {"type": "transcript.segment", "timestamp": s["t"],
                         "payload": {"text": s["text"], "speaker": f"S{s['speaker']}", "isFinal": True}})
        tag = " ".join(a.get("type", "?") for a in acts) or "·"
        print(f"  {i:>3} [{s['speaker'][:12]:12} {s['t']:>5}s] {tag}")
        for a in acts:
            if a.get("type") == "graph.nodes":
                for n in (a.get("payload", {}) or {}).get("nodes", []):
                    star = " ★" if n.get("notable") else ""
                    print(f"        + {n.get('kind','?'):11} [{n.get('topic','')[:22]:22}] {n.get('text','')}{star}")

    last = segs[-1]["t"] + 1 if segs else 0
    acts = post(ep, {"type": "manual", "timestamp": last, "payload": {}})
    print("\n  manual -> recap:")
    for a in acts:
        if a.get("type") == "recap":
            print("   ", (a.get("payload", {}) or {}).get("summary", ""))


if __name__ == "__main__":
    main()
