#!/usr/bin/env python3
"""Pull Otter.ai transcripts + screenshare frames into references/otter/ using local browser cookies.

Otter has no public API. This reuses the Chrome session you're already logged into
(via browser_cookie3) to call Otter's internal forward/api/v1 endpoints. No password,
SSO-irrelevant. Stay logged in to otter.ai in Chrome.

What it fetches (all verified live against the account 2026-06-17):
  - Transcripts you have access to: source=owned (182) + source=shared (135), deduped by otid.
    Text via bulk_export txt (works for owned AND shared; Otter-rendered, diarized).
  - Screenshare/presentation frames: get_speech images[] (source=auto_screenshot), downloaded
    from api.aisense.com with sessionid/csrftoken sent EXPLICITLY as cookies (cross-domain;
    the otter.ai cookie jar won't send them).
  - Audio recording (opt-in, large): get_speech download_url.

Politeness: Otter rate-limits bursts. We pace requests and back off; state is written per
item and frames are skipped if already on disk, so a throttled run resumes cleanly.

Usage:
  python3 otter_sync.py                 # transcripts (owned+shared) + frames, incremental
  python3 otter_sync.py --no-frames     # transcripts only
  python3 otter_sync.py --audio         # also download mp3 recordings (big)
  python3 otter_sync.py --max 20        # process at most N this run (trickle the big backlog)
"""
import argparse, io, json, os, re, time, zipfile
from pathlib import Path
import requests
from otter_session import open_session

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get("OTTER_OUT", ROOT / "references" / "otter"))
STATE = Path(__file__).parent / "otter_state.json"
BASE = "https://otter.ai/forward/api/v1/"
PAUSE = 0.8       # between speeches
FRAME_PAUSE = 0.2  # between frame downloads


def slug(s):
    return re.sub(r"[^\w\- ]", "", s or "").strip().replace(" ", "_")[:70] or "untitled"


def retrying(fn, what, tries=4):
    for i in range(tries):
        try:
            r = fn()
            r.raise_for_status()
            return r
        except (requests.Timeout, requests.HTTPError, requests.ConnectionError) as e:
            if i == tries - 1:
                raise
            wait = 5 * (2 ** i)
            print(f"    {what}: {type(e).__name__}, backing off {wait}s")
            time.sleep(wait)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-frames", action="store_true")
    ap.add_argument("--audio", action="store_true")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    state = json.loads(STATE.read_text()) if STATE.exists() else {}

    s = open_session()
    uid, csrf, media_cookies = s.uid, s.csrf, s.media

    speeches = {}
    for src in ("owned", "shared"):
        r = retrying(lambda src=src: s.get(BASE + "speeches",
                     params={"userid": uid, "page_size": 1000, "source": src}, timeout=60), f"list {src}")
        for sp in r.json()["speeches"]:
            speeches.setdefault(sp["otid"], sp)
        time.sleep(PAUSE)
    speeches = list(speeches.values())
    print(f"{len(speeches)} transcripts accessible (owned+shared, deduped)")

    todo = []
    for sp in speeches:
        stamp = sp.get("transcript_updated_at") or sp.get("modified_time") or 0
        if not args.force and state.get(sp["otid"], {}).get("stamp") == stamp:
            continue
        todo.append((sp, stamp))
    if args.max:
        todo = todo[: args.max]
    print(f"{len(todo)} to fetch (new or edited)")

    for i, (sp, stamp) in enumerate(todo, 1):
        otid = sp["otid"]
        date = time.strftime("%Y-%m-%d", time.localtime(sp.get("start_time") or sp.get("created_at") or 0))
        base = f"{date}_{slug(sp.get('title'))}__{otid[:8]}"

        r = retrying(lambda: s.post(BASE + "bulk_export", params={"userid": uid},
                     headers={"x-csrftoken": csrf, "referer": "https://otter.ai/"},
                     data={"formats": "txt", "speech_otid_list": [otid]}, timeout=60), "export")
        body = r.content
        if body[:2] == b"PK":
            z = zipfile.ZipFile(io.BytesIO(body)); body = z.read(z.namelist()[0])
        (OUT / f"{base}.txt").write_bytes(body)

        nframes = naudio = 0
        need_detail = (not args.no_frames and (sp.get("hasPhotos") or 0)) or args.audio
        detail = retrying(lambda: s.get(BASE + "speech", params={"userid": uid, "otid": otid},
                          timeout=60), "detail").json()["speech"] if need_detail else None

        if detail and not args.no_frames:
            imgs = detail.get("images") or []
            fdir = OUT / "frames" / base
            for j, im in enumerate(imgs):
                fp = fdir / f"{im.get('offset', 0):08.1f}s_{j:03d}.png"
                if fp.exists():
                    nframes += 1; continue
                fdir.mkdir(parents=True, exist_ok=True)
                fr = retrying(lambda im=im: requests.get(im["image_url"], cookies=media_cookies, timeout=60), "frame")
                fp.write_bytes(fr.content); nframes += 1
                time.sleep(FRAME_PAUSE)

        if detail and args.audio and detail.get("download_url"):
            ap_ = OUT / "audio" / f"{base}.mp3"
            if not ap_.exists():
                ar = requests.get(detail["download_url"], cookies=media_cookies, timeout=120)
                if ar.ok and ar.content[:1] != b"{":
                    ap_.parent.mkdir(exist_ok=True); ap_.write_bytes(ar.content)
            naudio = int(ap_.exists())

        state[otid] = {"stamp": stamp, "file": f"{base}.txt", "title": sp.get("title"),
                       "date": date, "frames": nframes, "audio": naudio}
        STATE.write_text(json.dumps(state, indent=2))
        extra = (f" +{nframes} frames" if nframes else "") + (" +audio" if naudio else "")
        print(f"  [{i}/{len(todo)}] {base}.txt ({len(body)}b){extra}")
        time.sleep(PAUSE)

    tf = sum(v.get("frames", 0) for v in state.values())
    print(f"done. {len(state)} transcripts, {tf} frames tracked in {STATE.name}")


if __name__ == "__main__":
    main()
