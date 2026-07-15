#!/usr/bin/env python3
"""Turn a transcript into a 3-layer insights report (Andrew's inverted-pyramid format).

Bottom-up production, top-down presentation. All passes are DeepSeek on NEAR; no agent
harness. Pipeline:
  1. chunk & index  — windowed pass: cut the transcript into topic-coherent chunks, tag
                      them (taxonomy grows/reused), keep verbatim quote + timestamp + density.
  2. insights+digest — one call per topic over its chunks: detailed insights citing the
                      chunks' timestamps, plus a short digest. Grounded, no fabrication.
Renders the chunk index (.md) + the report (.html): Summary / Detailed insights / Raw quotes.

  python3 otter_web/insights.py TRANSCRIPT.txt -o report.html [--max N] [--window 14]
  NEAR_KEY (or NEAR_API_KEY) must be in the environment.
"""
import argparse, json, os, re
from pathlib import Path
import requests

NEAR_URL = "https://cloud-api.near.ai/v1/chat/completions"
MODEL = os.environ.get("NEAR_MODEL", "deepseek-ai/DeepSeek-V4-Flash")
KEY = os.environ.get("NEAR_KEY") or os.environ["NEAR_API_KEY"]
HEAD = re.compile(r"^(?P<spk>.+?)\s{2,}(?P<ts>\d{1,2}:\d{2}(?::\d{2})?)\s*$")
USAGE = {"calls": 0, "prompt": 0, "completion": 0}


def parse(path):
    segs, cur = [], None
    for line in Path(path).read_text().splitlines():
        m = HEAD.match(line)
        if m:
            cur = {"i": len(segs), "speaker": m.group("spk").strip(), "ts": m.group("ts"), "text": ""}
            segs.append(cur)
        elif cur is not None and line.strip():
            cur["text"] = (cur["text"] + " " + line.strip()).strip()
    return [s for s in segs if s["text"]]


def near(system, user, max_tokens):
    r = requests.post(NEAR_URL, headers={"Authorization": f"Bearer {KEY}", "content-type": "application/json"},
                      json={"model": MODEL, "max_tokens": max_tokens, "temperature": 0.2,
                            "response_format": {"type": "json_object"},
                            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]},
                      timeout=120)
    r.raise_for_status()
    j = r.json()
    u = j.get("usage") or {}
    USAGE["calls"] += 1
    USAGE["prompt"] += u.get("prompt_tokens", 0)
    USAGE["completion"] += u.get("completion_tokens", 0)
    ch = j["choices"][0]
    if ch.get("finish_reason") == "length":
        raise RuntimeError(f"output truncated at max_tokens={max_tokens}; raise it or shrink the window")
    return json.loads(ch["message"]["content"])


CHUNK_SYS = (
    "You index a meeting transcript into detailed, citable chunks. You get the topic tags discovered so far and a "
    "window of numbered segments ([Sx] = speaker). Group CONSECUTIVE segments into topic-coherent chunks (a chunk is "
    "one coherent beat; split when the subject or intent shifts). For each chunk return: seg_start, seg_end (indices "
    "from this window), tags (1-2 short topic labels — REUSE a discovered tag verbatim when it fits, else a new short "
    "label), title (<=10 words, 'gist'), quote (verbatim words, UNDER ~45 words — elide aggressively with ' ... ' "
    "to keep only the load-bearing phrases, but NO paraphrase), density (high|med|low; low = banter/logistics). "
    "Return JSON: {\"chunks\":[{\"seg_start\":int,"
    "\"seg_end\":int,\"tags\":[...],\"title\":\"...\",\"quote\":\"...\",\"density\":\"...\"}]}")

INSIGHT_SYS = (
    "From these indexed chunks of ONE meeting topic, produce detailed insights and a short digest. Each insight: a "
    "title, ts (a list of the chunk timestamps that support it — only timestamps present in the chunks, never invent), "
    "and prose (1-3 sentences of substance). Then a digest entry per insight: a <=12-word headline + a one-line gist. "
    "Ground everything in the quotes; do not fabricate. Drop pure logistics/banter. Return JSON: {\"insights\":"
    "[{\"title\":\"...\",\"ts\":[...],\"prose\":\"...\"}],\"digest\":[{\"headline\":\"...\",\"gist\":\"...\"}]}")


def chunk_index(segs, window):
    tags, chunks = [], []
    i = 0
    while i < len(segs):
        win = segs[i:i + window]
        listing = "\n".join(f"{j}. [{s['speaker']} {s['ts']}] {s['text']}" for j, s in enumerate(win))
        out = near(CHUNK_SYS, f"Discovered tags: {', '.join(tags) or '(none yet)'}\n\nSegments:\n{listing}", 4000)
        for c in out.get("chunks", []):
            a, b = c.get("seg_start", 0), c.get("seg_end", c.get("seg_start", 0))
            if not (0 <= a < len(win)):
                continue
            b = min(max(b, a), len(win) - 1)
            for t in c.get("tags", []):
                if t not in tags:
                    tags.append(t)
            chunks.append({"tags": c.get("tags") or ["misc"], "speaker": win[a]["speaker"], "ts": win[a]["ts"],
                           "title": c.get("title", ""), "quote": c.get("quote", "").strip(),
                           "density": c.get("density", "med")})
        i += window
    return tags, chunks


def insights_for(topic, chunks):
    body = "\n".join(f"- [{c['ts']}] {c['speaker']}: {c['quote']}" for c in chunks)
    return near(INSIGHT_SYS, f"Topic: {topic}\n\nChunks:\n{body}", 1800)


def esc(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;")


def render(title, src_name, topics):
    parts = [f"""<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>insights — {esc(title)}</title>
<style>:root{{color-scheme:light}}body{{max-width:820px;margin:0 auto;padding:28px 22px;font:15px/1.6 -apple-system,system-ui,sans-serif;color:#1a1a1a}}
h1{{font-size:24px}}h2{{font-size:19px;margin-top:34px;border-bottom:2px solid #e3b505;padding-bottom:4px}}
h3{{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9a7a00;margin:20px 0 8px}}
ul.sum li{{margin:0 0 7px}}.insight{{margin:0 0 14px}}.insight h4{{margin:0 0 3px;font-size:15px}}
.ts{{color:#9a7a00;font-weight:400;font-size:12px}}blockquote{{margin:0 0 12px;padding:6px 0 6px 12px;border-left:3px solid #ddd;color:#333}}
.who{{color:#666;font-size:12px;font-weight:600}}.who .t{{color:#9a7a00;font-weight:400}}.src{{font-size:12px}}.meta{{color:#888;font-size:13px}}</style></head>
<body><h1>Insights — {esc(title)}</h1><p class="meta">Auto-generated from <a class="src" href="{esc(src_name)}">{esc(src_name)}</a></p>"""]
    for t in topics:
        parts.append(f"<h2>{esc(t['topic'])}</h2>")
        parts.append('<div class="layer"><h3>Summary</h3><ul class="sum">')
        for d in t["digest"]:
            parts.append(f"<li><b>{esc(d.get('headline',''))}</b> {esc(d.get('gist',''))}</li>")
        parts.append("</ul></div>")
        parts.append('<div class="layer"><h3>Detailed insights</h3>')
        for ins in t["insights"]:
            ts = ", ".join(ins.get("ts", []))
            parts.append(f'<div class="insight"><h4>{esc(ins.get("title",""))} '
                         f'<span class="ts">· {esc(ts)}</span></h4><div>{esc(ins.get("prose",""))}</div></div>')
        parts.append("</div>")
        parts.append('<div class="layer"><h3>Raw quotes</h3>')
        for c in t["chunks"]:
            parts.append(f'<blockquote><span class="who">{esc(c["speaker"])} · '
                         f'<span class="t">{esc(c["ts"])}</span></span><br>{esc(c["quote"])}</blockquote>')
        parts.append("</div>")
    parts.append("</body></html>")
    return "\n".join(parts)


def render_index_md(title, src, tags, chunks):
    lines = [f"# {title} — chunk index", "", f"Source: `{src}` ({len(chunks)} chunks, tags: {', '.join(tags)})", "", "## Chunks", ""]
    for c in chunks:
        lines.append(f"### [{']['.join(c['tags'])}] {c['ts']} {c['speaker']} — {c['title']}")
        if c["density"] != "low":
            lines.append(f"> \"{c['quote']}\"")
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--window", type=int, default=14)
    ap.add_argument("--max", type=int, default=0)
    ap.add_argument("--price-in", type=float, default=0.0)
    ap.add_argument("--price-out", type=float, default=0.0)
    args = ap.parse_args()

    segs = parse(args.file)
    if args.max:
        segs = segs[:args.max]
    title = Path(args.file).stem
    print(f"parsed {len(segs)} segments; chunking in windows of {args.window}…")

    tags, chunks = chunk_index(segs, args.window)
    print(f"indexed {len(chunks)} chunks across {len(tags)} tags: {', '.join(tags)}")

    # group chunks by primary tag, order topics by total chunk count
    by_tag = {}
    for c in chunks:
        by_tag.setdefault(c["tags"][0], []).append(c)
    topics = []
    for tag, cs in sorted(by_tag.items(), key=lambda kv: -len(kv[1])):
        if all(c["density"] == "low" for c in cs):
            continue
        print(f"  insights for '{tag}' ({len(cs)} chunks)…")
        ins = insights_for(tag, cs)
        topics.append({"topic": tag, "chunks": cs, "insights": ins.get("insights", []), "digest": ins.get("digest", [])})

    idx_name = Path(args.out).with_suffix(".chunks.md").name
    Path(args.out).with_suffix(".chunks.md").write_text(render_index_md(title, Path(args.file).name, tags, chunks))
    Path(args.out).write_text(render(title, idx_name, topics))

    tot = USAGE["prompt"] + USAGE["completion"]
    print(f"\nwrote {args.out} (+ {idx_name})")
    print(f"tokens: {USAGE['calls']} calls · {USAGE['prompt']} in + {USAGE['completion']} out = {tot} total")
    if args.price_in or args.price_out:
        cost = USAGE["prompt"] / 1e6 * args.price_in + USAGE["completion"] / 1e6 * args.price_out
        print(f"cost: ${cost:.4f}")


if __name__ == "__main__":
    main()
