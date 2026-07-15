#!/usr/bin/env python3
"""Mock Otter from a captured transcript and drive the live decode path.

Parses a diarized Otter export (`Speaker  M:SS` header lines + utterance), shapes it
like Otter's `speech.transcripts[]`, monkeypatches the server's session, and replays
the meeting in batches through `graph_state()` — the exact path a live meeting hits.

  python3 otter_web/replay.py FILE.txt                 # offline stub decoder (no network), asserts
  python3 otter_web/replay.py FILE.txt --near          # real NEAR decoder (costs tokens)
  python3 otter_web/replay.py FILE.txt --batch 8 --max 60
"""
import argparse, json, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from otter_web import server as S

HEAD = re.compile(r"^(?P<spk>.+?)\s{2,}(?P<ts>\d{1,2}:\d{2}(?::\d{2})?)\s*$")


def parse(path):
    labels, segs, cur = {}, [], None
    for line in Path(path).read_text().splitlines():
        m = HEAD.match(line)
        if m:
            spk = m.group("spk").strip()
            labels.setdefault(spk, len(labels))
            cur = {"uuid": f"r{len(segs)}", "order": len(segs), "label": labels[spk], "transcript": ""}
            segs.append(cur)
        elif cur is not None and line.strip():
            cur["transcript"] = (cur["transcript"] + " " + line.strip()).strip()
    return [s for s in segs if s["transcript"]]


def stub_decode(open_topics, segs):
    """Deterministic offline decoder: heuristic kind, topic bucketed every 8 segs."""
    nodes = []
    for i, s in enumerate(segs):
        txt = s["text"]
        kind = ("question" if "?" in txt
                else "decision" if re.search(r"\b(let's|lets|we'll|agreed|decide|go with)\b", txt.lower())
                else "point")
        good = bool(re.search(r"\b(good point|exactly|the key|brilliant|that's right|love that|great idea)\b", txt.lower()))
        bucket = int(s["uuid"][1:]) // 8
        nodes.append({"i": i, "kind": kind, "topic": f"topic-{bucket}", "text": txt[:60], "rel": "continues", "good": good})
    return nodes


class FakeResp:
    def __init__(self, d): self.d = d
    def json(self): return self.d


class FakeSession:
    uid = "replay"

    def __init__(self, segs): self.segs, self.k = segs, 0

    def advance(self, n): self.k = min(len(self.segs), self.k + n)

    def get(self, url, **kw):
        return FakeResp({"speech": {"transcripts": self.segs[:self.k], "live_status": "live"}})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--batch", type=int, default=6, help="segments revealed per poll")
    ap.add_argument("--max", type=int, default=0, help="cap total segments (0 = all)")
    ap.add_argument("--near", action="store_true", help="use the real NEAR decoder")
    ap.add_argument("--recap", action="store_true", help="self-test recap_to_matrix() with a stubbed NEAR recap")
    ap.add_argument("--durable", action="store_true", help="self-test STATE persistence + transcript jsonl across a restart")
    ap.add_argument("--json", help="write final graph to this path")
    ap.add_argument("--price-in", type=float, default=0.0, help="$/1M input tokens (for cost estimate)")
    ap.add_argument("--price-out", type=float, default=0.0, help="$/1M output tokens")
    args = ap.parse_args()

    segs = parse(args.file)
    if args.max:
        segs = segs[:args.max]
    print(f"parsed {len(segs)} segments; speakers up to S{max(s['label'] for s in segs)}")

    sess = FakeSession(segs)
    S.otter = lambda: sess
    stem = Path(args.file).stem
    otid = stem.rsplit("__", 1)[-1] if "__" in stem else "replay"
    m = re.match(r"(\d{4}-\d{2}-\d{2})_(.+?)__", stem)
    title = (m.group(2).replace("_", " ") if m else stem)
    started = m.group(1) if m else None
    S.live_speech = lambda s: {"otid": otid, "title": title, "created_at": started}
    if not args.near:
        S.decode = stub_decode

    if args.recap:
        sess.advance(args.batch)  # reveal a window of transcript
        S.recap = lambda *a, **k: {"summary": "• topic X\n• open question Y", "used_slide": False}
        out = S.recap_to_matrix()
        print(f"\nrecap returned: {out}")
        assert out["summary"], "empty recap"
        print("\nOK")
        return

    if args.durable:
        import tempfile
        if not args.near:
            S.decode = stub_decode
        tmp = Path(tempfile.mkdtemp(prefix="otter-durable-"))
        S.DATA, S.STATE_DIR, S.LIVE_DIR = tmp, tmp / "state", tmp / "live"
        posts = []
        S.matrix.post = lambda body, html=None: posts.append(body)

        def drain():
            sess.k = 0
            while sess.k < len(segs):
                sess.advance(args.batch)
                S.graph_state()

        print(f"data dir: {tmp}")
        drain()  # first pass — live meeting
        first = list(posts)
        st = S.STATE[otid]
        print(f"pass 1: {len(first)} matrix posts, {len(st['done'])} done, {len(st['announced'])} announced, "
              f"started={st['started']}")
        assert first, "first pass posted nothing"

        jsonl = S.LIVE_DIR / f"{otid}.jsonl"
        lines = [json.loads(l) for l in jsonl.read_text().splitlines()]
        uuids = [l["uuid"] for l in lines]
        assert len(uuids) == len(set(uuids)), "duplicate uuid in transcript jsonl"
        assert len(uuids) == len({s["uuid"] for s in segs}), "transcript missing segments"
        print(f"transcript jsonl: {len(lines)} segments, no dup uuids  ({jsonl})")

        # --- simulate restart: drop in-memory STATE, reload from disk ---
        S.STATE.clear()
        posts.clear()
        reloaded = S.load_state(otid)
        assert reloaded["done"] == st["done"] and reloaded["announced"] == st["announced"], "reload mismatch"
        print(f"after restart (reloaded from disk): {len(reloaded['done'])} done, "
              f"{len(reloaded['announced'])} announced, started={reloaded['started']}")

        drain()  # second pass — everything already done/announced
        print(f"pass 2: {len(posts)} new matrix posts")
        assert not posts, f"restart re-posted {len(posts)}: {posts}"
        after = [json.loads(l) for l in jsonl.read_text().splitlines()]
        assert len(after) == len(lines), "second pass re-appended transcript"
        print("transcript unchanged on second pass (idempotent)")
        print("\nOK")
        return

    usage = {"calls": 0, "prompt": 0, "completion": 0}
    orig_post = S.requests.post
    def counting_post(*a, **k):
        r = orig_post(*a, **k)
        try:
            u = r.json().get("usage") or {}
            usage["calls"] += 1
            usage["prompt"] += u.get("prompt_tokens", 0)
            usage["completion"] += u.get("completion_tokens", 0)
        except Exception:
            pass
        return r
    S.requests.post = counting_post

    seen, last = 0, {}
    step = 0
    while sess.k < len(segs):
        sess.advance(args.batch)
        step += 1
        last = S.graph_state()
        nodes = last["nodes"]
        new = nodes[seen:]
        seen = len(nodes)
        print(f"\n--- poll {step} (segments {sess.k}/{len(segs)}, {len(nodes)} nodes) ---")
        for n in new:
            star = " ✨" if n.get("good") else ""
            print(f"  [{n['kind']:11}] {n['speaker']} · {n['topic'][:24]:24} | {n['text'][:70]}{star}")

    print(f"\n=== final: {len(last['nodes'])} nodes, {len(last['topics'])} topics, "
          f"{len(last['decisions'])} decisions, {len(last['good'])} good points ===")
    for t in last["topics"]:
        print(f"  topic {t['id']}: {t['label']}  ({len(t['node_ids'])} nodes)")

    if usage["calls"]:
        tot = usage["prompt"] + usage["completion"]
        print(f"\ntokens: {usage['calls']} calls · {usage['prompt']} in + {usage['completion']} out = {tot} total"
              f"  (~{tot // max(usage['calls'],1)}/call)")
        if args.price_in or args.price_out:
            cost = usage["prompt"] / 1e6 * args.price_in + usage["completion"] / 1e6 * args.price_out
            print(f"cost: ${cost:.4f}  (in ${args.price_in}/1M, out ${args.price_out}/1M)")

    if args.json:
        Path(args.json).write_text(json.dumps(last, indent=1))
        print(f"wrote {args.json}")

    assert last["nodes"], "no nodes decoded"
    assert set(last["decisions"]) <= {n["id"] for n in last["nodes"]}, "decisions not a subset of nodes"
    assert all(n["topic_id"] for n in last["nodes"]), "node missing topic_id"
    assert set(last["good"]) == {n["id"] for n in last["nodes"] if n.get("good")}, "good list mismatch"
    print("\nOK")


if __name__ == "__main__":
    main()
