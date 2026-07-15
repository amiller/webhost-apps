#!/usr/bin/env python3
"""Local web app: follow a live Otter meeting (transcript + screenshots) with a
"what were we talking about?" button that also reads the current slide.

Runs entirely on your machine. Reuses the Chrome otter.ai session (browser_cookie3)
to poll the live transcript and screenshare frames, and your NEAR AI Cloud key to
summarize on demand. Frames live on api.aisense.com (cookie-auth), so the server
proxies them via /frame. When a recent slide exists, the recap goes to Qwen3-VL so
it accounts for what's on screen; otherwise a fast text model.

  python3 server.py            # serves on http://localhost:8137
"""
import base64, hashlib, hmac, json, os, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import requests
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from otter_session import open_session
from otter_web import matrix, users, connections, google_app

HERE = Path(__file__).parent
PORT = int(os.environ.get("PORT", 8137))
OTTER = os.environ.get("OTTER_API_BASE", "https://otter.ai/forward/api/v1/")
NEAR_URL = os.environ.get("NEAR_URL", "https://cloud-api.near.ai/v1/chat/completions")
TEXT_MODEL = os.environ.get("NEAR_MODEL", "deepseek-ai/DeepSeek-V4-Flash")
VL_MODEL = os.environ.get("NEAR_VL_MODEL", "google/gemini-2.5-flash")


NEAR_KEY = os.environ.get("NEAR_KEY") or os.environ["NEAR_API_KEY"]
BASE_URL = os.environ.get("BASE_URL", "http://localhost:8137")

OWNER_TOKEN = os.environ.get("OWNER_TOKEN")
if not OWNER_TOKEN:
    print("WARNING: OWNER_TOKEN unset — auth disabled, everyone treated as owner (local dev only)", file=sys.stderr)


def share_sig(otid):
    return hmac.new(OWNER_TOKEN.encode(), otid.encode(), hashlib.sha256).hexdigest()[:16]


def share_url(otid):
    return f"{BASE_URL}/#view={otid}.{share_sig(otid)}"

DATA = users.DATA
STATE_DIR = DATA / "state"
LIVE_DIR = DATA / "live"


_SESSION = {"s": None, "t": 0.0}
def otter():
    # reuse the session (open_session does a /user round-trip each call); cookie is static
    now = time.time()
    if _SESSION["s"] is None or now - _SESSION["t"] > 300:
        _SESSION["s"] = open_session(); _SESSION["t"] = now
    return _SESSION["s"]


def live_speech(s):
    speeches = s.get(OTTER + "speeches", params={"userid": s.uid, "page_size": 20, "source": "owned"},
                     timeout=40).json()["speeches"]
    live = [x for x in speeches if x.get("live_status") == "live"]
    return live[0] if live else None


_LIVE = {"sp": None, "t": 0.0}
def live_speech_cached(s, ttl=8):
    # the live-status check (speeches list) is the slow per-request cost; cache it briefly so the
    # dashboard's /conversations + /graph polls (and otter_wake) don't each re-hit the Otter API
    now = time.time()
    if now - _LIVE["t"] >= ttl:
        _LIVE.update(sp=live_speech(s), t=now)
    return _LIVE["sp"]


def proxied(url):
    return "/frame?u=" + base64.urlsafe_b64encode(url.encode()).decode()


def live_state(after):
    s = otter()
    sp = live_speech_cached(s)
    if not sp:
        return {"live": False}
    d = s.get(OTTER + "speech", params={"userid": s.uid, "otid": sp["otid"]}, timeout=40).json()["speech"]
    segs = sorted(d.get("transcripts") or [], key=lambda x: x.get("order") or 0)
    rows = [{"order": int(t.get("order") or 0), "uuid": t.get("uuid"), "speaker": f"S{t.get('label')}",
             "text": (t.get("transcript") or "").strip()}
            for t in segs if (t.get("transcript") or "").strip()]
    rows = rows[-40:] if after <= 0 else [r for r in rows if r["order"] > after]
    mx = max((r["order"] for r in rows), default=after)
    imgs = sorted(d.get("images") or [], key=lambda x: x.get("offset") or 0)
    images = [{"offset": im.get("offset"), "src": proxied(im["image_url"])} for im in imgs[-8:]]
    return {"live": True, "otid": sp["otid"], "title": sp.get("title"), "segments": rows, "max_order": mx, "images": images}


def fetch_frame(url):
    if not (urlparse(url).hostname or "").endswith("aisense.com"):
        raise ValueError("only api.aisense.com frames are proxied")
    r = requests.get(url, cookies=otter().media, timeout=30)
    r.raise_for_status()
    return r.content, r.headers.get("content-type", "image/png")


def latest_slide():
    s = otter()
    sp = live_speech_cached(s)
    if not sp:
        return None
    d = s.get(OTTER + "speech", params={"userid": s.uid, "otid": sp["otid"]}, timeout=40).json()["speech"]
    imgs = sorted(d.get("images") or [], key=lambda x: x.get("offset") or 0)
    if not imgs:
        return None
    r = requests.get(imgs[-1]["image_url"], cookies=s.media, timeout=30)
    r.raise_for_status()
    return "data:image/png;base64," + base64.b64encode(r.content).decode()


def recap(text, use_slide=True):
    sys = ("You are catching someone up on a live meeting they glanced away from. From the recent transcript "
           "(may have fragments/mis-hears) and, if provided, the current shared screen, answer 'what were we "
           "just talking about?' Be tight and concrete: 2-4 short bullets on the current topic(s), plus any "
           "question or decision on the table right now. If a slide is shown, ground the recap in it. No preamble.")
    slide = latest_slide() if use_slide else None
    user = (f"Recent transcript:\n{text}\n\nWhat were we just talking about?")
    if slide:
        content = [{"type": "text", "text": user}, {"type": "image_url", "image_url": {"url": slide}}]
        model = VL_MODEL
    else:
        content = user
        model = TEXT_MODEL
    r = requests.post(NEAR_URL, headers={"Authorization": f"Bearer {NEAR_KEY}", "content-type": "application/json"},
                      json={"model": model, "max_tokens": 450, "temperature": 0.3,
                            "messages": [{"role": "system", "content": sys}, {"role": "user", "content": content}]},
                      timeout=90)
    r.raise_for_status()
    return {"summary": r.json()["choices"][0]["message"]["content"].strip(), "used_slide": bool(slide)}


def recap_to_matrix(use_slide=True):
    """On-demand 'catch you up' for a joiner: recap the live transcript and post it to Matrix.
    Stretch trigger (out of scope): fire this from Otter's presence socket on an actual new joiner."""
    st = live_state(0)
    if not st.get("live"):
        raise RuntimeError("no live meeting to recap")
    text = "\n".join(f"[{r['speaker']}] {r['text']}" for r in st["segments"])
    out = recap(text, use_slide=use_slide)
    title = st.get("title") or "live meeting"
    head = f"📍 catching you up — {title}"
    matrix.post(f"{head}\n{out['summary']}",
                html=f"<b>{head}</b><br>" + out["summary"].replace("\n", "<br>"))
    return out


# --- conversation decoder: typed-node graph over the live transcript ---
STATE = {}  # otid -> {topics: {label: id}, tcount, nodes: [...], done: set(uuid)}
DECODE_BATCH = 4
DECODE_MAX = 10   # cap segments per decode call so the model's JSON fits max_tokens (live backlog can be large)
DECODE_SYS = (
    "You decode a meeting transcript into a typed conversation graph. You get the topics already open and a "
    "batch of new numbered segments ([Sx] is a speaker cluster id). For each segment that carries meaning, emit "
    "one node; skip pure filler/backchannel ('yeah', 'right'). Kinds: topic (frames a subject), question, point "
    "(a substantive claim/idea), decision (something agreed/chosen), divergence (a tangent/disagreement), "
    "action_item (a to-do), aside. Give each node a short topic label, REUSING an open topic label verbatim when "
    "it fits, else a new short label. rel links it to the prior segment: new-topic|continues|reply-to|digression|"
    "resolves. Add \"good\":true on a node ONLY when it is a genuinely strong/insightful point — a crisp idea "
    "everyone reacts to or that visibly moves the discussion; be sparing. Return JSON only: "
    "{\"nodes\":[{\"i\":<segment index>,\"kind\":...,\"topic\":\"...\","
    "\"text\":\"<=12 word canonical phrasing\",\"rel\":...,\"good\":<true|omit>}]}")


def hint_text(speakers, corrections):
    """Owner correction hints, prepended to the decode prompt so new nodes use the fixed names."""
    parts = []
    if speakers:
        parts.append("Speaker names: " + ", ".join(f"{c}={n}" for c, n in speakers.items()) + ".")
    if corrections:
        parts.append("Known corrections: " + ", ".join(f"{c['wrong']}→{c['right']}" for c in corrections) + ".")
    return ("Owner-supplied guidance (use these names verbatim): " + " ".join(parts) + "\n\n") if parts else ""


def decode(open_topics, segs, hints=""):
    listing = "\n".join(f"{i}. [{s['speaker']}] {s['text']}" for i, s in enumerate(segs))
    user = (f"{hints}Open topics: {', '.join(open_topics) or '(none yet)'}\n\n"
            f"New segments (in order):\n{listing}\n\nReturn JSON only.")
    r = requests.post(NEAR_URL, headers={"Authorization": f"Bearer {NEAR_KEY}", "content-type": "application/json"},
                      json={"model": TEXT_MODEL, "max_tokens": 800, "temperature": 0.2,
                            "response_format": {"type": "json_object"},
                            "messages": [{"role": "system", "content": DECODE_SYS},
                                         {"role": "user", "content": user}]},
                      timeout=90)
    r.raise_for_status()
    return json.loads(r.json()["choices"][0]["message"]["content"]).get("nodes", [])


REFLECT_EVERY = 8  # nodes between holistic passes
ARCHETYPES = ("brainstorm", "decision-making", "status-update", "one-on-one", "debate",
              "interview", "retro", "presentation", "social")
TENTATIVE = {"brainstorm", "social"}  # archetypes where decisions are not yet firm — don't auto-post them
REFLECT_SYS = (
    "You read a meeting's decoded conversation graph (typed nodes + open topics) and step back to "
    "interpret it HOLISTICALLY — not segment by segment. Return JSON only: "
    "{\"archetype\": one of [" + ", ".join(ARCHETYPES) + "] (the kind of meeting this currently is — "
    "it may differ from earlier), \"crux\": \"<=15 words: the single most important thing or the open "
    "question on the table right now\", \"throughline\": \"<=25 words: the path the conversation has "
    "taken, as one narrative arc\"}.")


def reflect(nodes, topics):
    """Holistic second-order pass over the compressed node graph (cheap; nodes are <=12-word phrasings)."""
    listing = "\n".join(f"- [{n['kind']}] {n['text']} (topic: {n['topic']})" for n in nodes[-50:])
    user = f"Open topics: {', '.join(topics) or '(none)'}\n\nConversation so far:\n{listing}\n\nReturn JSON only."
    r = requests.post(NEAR_URL, headers={"Authorization": f"Bearer {NEAR_KEY}", "content-type": "application/json"},
                      json={"model": TEXT_MODEL, "max_tokens": 300, "temperature": 0.3,
                            "response_format": {"type": "json_object"},
                            "messages": [{"role": "system", "content": REFLECT_SYS},
                                         {"role": "user", "content": user}]},
                      timeout=90)
    r.raise_for_status()
    return json.loads(r.json()["choices"][0]["message"]["content"])


def load_state(otid):
    """Load persisted STATE[otid] from disk (sets serialized as lists), else a fresh dict."""
    if otid in STATE:
        return STATE[otid]
    p = STATE_DIR / f"{otid}.json"
    if p.exists():
        d = json.loads(p.read_text())
        for k in ("done", "announced", "logged"):
            d[k] = set(d.get(k, []))
        STATE[otid] = d
    else:
        STATE[otid] = {"topics": {}, "tcount": 0, "nodes": [], "done": set(), "announced": set(),
                       "logged": set(), "started": False, "meta": {}, "speakers": {}, "corrections": []}
    return STATE[otid]


def apply_hints(items, speakers, corrections):
    """Map each item's `speaker` cluster id through `speakers` (keeping the raw id) and apply
    text `corrections` (wrong→right) to its `text`. Returns new dicts; inputs untouched."""
    out = []
    for it in items:
        d = dict(it)
        cid = d.get("speaker")
        if cid is not None:
            d["cluster"] = cid
            d["speaker"] = speakers.get(cid, cid)
        text = d.get("text", "")
        for c in corrections:
            if c.get("wrong"):
                text = text.replace(c["wrong"], c.get("right", ""))
        d["text"] = text
        out.append(d)
    return out


def save_state(otid, st):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    d = dict(st, done=sorted(st["done"]), announced=sorted(st["announced"]), logged=sorted(st["logged"]))
    tmp = STATE_DIR / f"{otid}.json.tmp"
    tmp.write_text(json.dumps(d))
    tmp.rename(STATE_DIR / f"{otid}.json")


def append_transcript(otid, rows, logged):
    """Append uuids not yet in `logged` to /data/otter/live/<otid>.jsonl, idempotent by uuid."""
    new = [r for r in rows if r["uuid"] not in logged]
    if not new:
        return
    LIVE_DIR.mkdir(parents=True, exist_ok=True)
    with (LIVE_DIR / f"{otid}.jsonl").open("a") as f:
        for i, r in enumerate(new):
            f.write(json.dumps({"order": len(logged) + i, "uuid": r["uuid"],
                                "speaker": r["speaker"], "text": r["text"]}) + "\n")
    logged.update(r["uuid"] for r in new)


def graph_state():
    s = otter()
    sp = live_speech_cached(s)
    if not sp:
        return {"live": False}
    otid = sp["otid"]
    d = s.get(OTTER + "speech", params={"userid": s.uid, "otid": otid}, timeout=40).json()["speech"]
    rows = [{"uuid": t.get("uuid"), "speaker": f"S{t.get('label')}", "text": (t.get("transcript") or "").strip()}
            for t in sorted(d.get("transcripts") or [], key=lambda x: x.get("order") or 0)
            if (t.get("transcript") or "").strip()]
    st = load_state(otid)
    st.setdefault("meta", {})
    st["meta"].setdefault("title", sp.get("title") or "untitled")
    _sa = sp.get("created_at") or sp.get("start_time")
    st["meta"].setdefault("started_at", time.strftime("%Y-%m-%d", time.localtime(_sa)) if isinstance(_sa, (int, float)) else _sa)
    append_transcript(otid, rows, st["logged"])
    if not st["started"]:
        st["started"] = True
        matrix.post(f"📡 meeting started — “{sp.get('title') or 'untitled'}”. Watching live; I'll surface decisions, good points, and a recap on request. Watch it live: {BASE_URL}/")
    tentative = st["meta"].get("reflection", {}).get("archetype") in TENTATIVE  # context gates autonomy
    new = [r for r in rows if r["uuid"] not in st["done"]][:DECODE_MAX]
    if len(new) >= DECODE_BATCH:
        hints = hint_text(st.get("speakers", {}), st.get("corrections", []))
        for nd in (decode(list(st["topics"]), new, hints) if hints else decode(list(st["topics"]), new)):
            i = nd.get("i")
            if not isinstance(i, int) or i >= len(new):
                continue
            label = nd.get("topic") or "misc"
            if label not in st["topics"]:
                st["tcount"] += 1
                st["topics"][label] = f"t{st['tcount']}"
            node = {"id": new[i]["uuid"], "speaker": new[i]["speaker"], "kind": nd.get("kind", "point"),
                    "text": nd.get("text") or new[i]["text"], "topic_id": st["topics"][label],
                    "topic": label, "rel": nd.get("rel", "continues"), "good": bool(nd.get("good"))}
            st["nodes"].append(node)
            # in a brainstorm/social, decisions aren't firm yet — record them but don't ping
            if node["kind"] in ("decision", "action_item") and node["id"] not in st["announced"] and not tentative:
                st["announced"].add(node["id"])
                matrix.post(f"🟢 {node['kind'].replace('_', ' ')}: {node['text']}  — {node['speaker']} · topic “{node['topic']}”")
            if node["good"] and node["id"] not in st["announced"]:
                st["announced"].add(node["id"])
                matrix.post(f"✨ good point — {node['text']} — {node['speaker']}")
        for r in new:
            st["done"].add(r["uuid"])
    if len(st["nodes"]) - st["meta"].get("reflected_at", 0) >= REFLECT_EVERY and st["nodes"]:
        out = reflect(st["nodes"], list(st["topics"]))
        st["meta"]["reflected_at"] = len(st["nodes"])
        prev = st["meta"].get("reflection", {}).get("archetype")
        st["meta"]["reflection"] = out
        if out["archetype"] != prev:
            st["meta"].setdefault("archetype_tl", []).append({"at_node": len(st["nodes"]), "archetype": out["archetype"]})
            if prev:  # an actual shift, not the first reading
                matrix.post(f"🧭 shift → {out['archetype']} · crux: {out['crux']}")
    save_state(otid, st)
    topics = [{"id": tid, "label": lbl, "node_ids": [n["id"] for n in st["nodes"] if n["topic_id"] == tid]}
              for lbl, tid in st["topics"].items()]
    decisions = [n["id"] for n in st["nodes"] if n["kind"] in ("decision", "action_item")]
    good = [n["id"] for n in st["nodes"] if n.get("good")]
    speakers, corrections = st.get("speakers", {}), st.get("corrections", [])
    return {"live": True, "title": sp.get("title"), "topics": topics,
            "nodes": apply_hints(st["nodes"], speakers, corrections),
            "decisions": decisions, "good": good, "speakers": speakers, "corrections": corrections,
            "reflection": st["meta"].get("reflection", {}), "archetype_tl": st["meta"].get("archetype_tl", []),
            "clusters": sorted({n["speaker"] for n in st["nodes"]})}


def live_otid():
    """otid of the currently-live meeting, or None (errors propagate)."""
    sp = live_speech(otter())
    return sp["otid"] if sp else None


# --- owner backfill: decode the user's EXISTING Otter meetings into the same graph state ---
import threading
BACKFILL = {"running": False, "done": 0, "total": 0, "current": None, "errors": []}


def _decode_segments(otid, rows, st):
    """Run graph_state's decode loop over ALL of `rows` in DECODE_MAX chunks (no Matrix)."""
    append_transcript(otid, rows, st["logged"])
    while True:
        new = [r for r in rows if r["uuid"] not in st["done"]][:DECODE_MAX]
        if len(new) < DECODE_BATCH:
            break
        for nd in decode(list(st["topics"]), new):
            i = nd.get("i")
            if not isinstance(i, int) or i >= len(new):
                continue
            label = nd.get("topic") or "misc"
            if label not in st["topics"]:
                st["tcount"] += 1
                st["topics"][label] = f"t{st['tcount']}"
            st["nodes"].append({"id": new[i]["uuid"], "speaker": new[i]["speaker"], "kind": nd.get("kind", "point"),
                                "text": nd.get("text") or new[i]["text"], "topic_id": st["topics"][label],
                                "topic": label, "rel": nd.get("rel", "continues"), "good": bool(nd.get("good"))})
        for r in new:
            st["done"].add(r["uuid"])
        save_state(otid, st)
    if st["nodes"]:
        st["meta"]["reflection"] = reflect(st["nodes"], list(st["topics"]))
        st["meta"]["reflected_at"] = len(st["nodes"])
    save_state(otid, st)


def _past_speeches(s, limit):
    speeches = []
    for source in ("owned", "shared"):
        speeches += s.get(OTTER + "speeches", params={"userid": s.uid, "page_size": 60, "source": source},
                          timeout=40).json().get("speeches", [])
    speeches = [x for x in speeches if x.get("live_status") != "live"]
    speeches.sort(key=lambda x: x.get("created_at") or x.get("start_time") or 0, reverse=True)
    todo = [x for x in speeches if not (STATE_DIR / f"{x['otid']}.json").exists()]
    return todo[:limit]


def backfill(limit=12, todo=None):
    s = otter()
    if todo is None:
        todo = _past_speeches(s, limit)
    BACKFILL.update(running=True, done=0, total=len(todo), current=None, errors=[])
    for sp in todo:
        otid = sp["otid"]
        BACKFILL["current"] = sp.get("title") or otid
        try:
            d = s.get(OTTER + "speech", params={"userid": s.uid, "otid": otid}, timeout=60).json()["speech"]
            rows = [{"uuid": t.get("uuid"), "speaker": f"S{t.get('label')}", "text": (t.get("transcript") or "").strip(),
                     "order": t.get("order") or 0}
                    for t in sorted(d.get("transcripts") or [], key=lambda x: x.get("order") or 0)
                    if (t.get("transcript") or "").strip()]
            st = load_state(otid)
            st.setdefault("meta", {})
            st["meta"]["title"] = d.get("title") or sp.get("title") or otid
            ts = d.get("start_time") or d.get("created_at") or sp.get("created_at")
            st["meta"]["started_at"] = time.strftime("%Y-%m-%d", time.localtime(ts)) if isinstance(ts, (int, float)) else ts
            st["started"] = True  # don't let a later live view re-announce a backfilled meeting
            _decode_segments(otid, rows, st)
        except Exception as e:
            BACKFILL["errors"].append({"otid": otid, "title": sp.get("title"), "error": f"{type(e).__name__}: {e}"})
        BACKFILL["done"] += 1
    BACKFILL.update(running=False, current=None)


def ingest_gemini(uid, file_id, title=None, date=None):
    """Pull a Gemini-notes doc and run it through the SAME decode pipeline as Otter transcripts —
    each non-empty line is a segment (speaker 'Gemini'). It then shows up as a conversation."""
    text = google_app.gemini_text(uid, file_id)
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    otid = "gem_" + file_id
    rows = [{"uuid": f"{file_id}:{i}", "speaker": "Gemini", "text": l, "order": i} for i, l in enumerate(lines)]
    st = load_state(otid)
    st.setdefault("meta", {})
    st["meta"]["title"] = title or "Gemini notes"
    st["meta"]["started_at"] = date
    st["meta"]["source"] = "gemini"
    st["started"] = True  # never let a live view re-announce an imported note
    _decode_segments(otid, rows, st)
    return {"otid": otid, "title": st["meta"]["title"], "n_segments": len(rows), "n_nodes": len(st["nodes"])}


def start_backfill(limit=12):
    if BACKFILL["running"]:
        return {"started": False, "total": BACKFILL["total"]}
    todo = _past_speeches(otter(), limit)
    BACKFILL.update(running=True, done=0, total=len(todo), current=None, errors=[])
    threading.Thread(target=lambda: backfill(limit, todo), daemon=True).start()
    return {"started": True, "total": len(todo)}


# --- audience proposer: recommend a sharing tier; the owner accepts it (human-in-the-loop) ---
AUDIENCE_SYS = (
    "You are an audience proposer for a meeting copilot. Given a conversation's decoded insights and a "
    "transcript sample, judge who it's fit to share with. Tiers: \"public\" (anyone), \"cohort\" "
    "(semi-trusted peers), \"private\" (owner only). Be conservative: flag PII, named competitor call-outs, "
    "confidential, or half-baked/unresolved content as reasons NOT to go public. Do NOT flag ordinary "
    "internal project or feature names — only flag genuinely confidential/unreleased, PII, or "
    "competitor-sensitive material. Return JSON only: "
    "{\"suggested\":\"private\"|\"cohort\"|\"public\",\"confidence\":<0-1>,\"rationale\":\"1-2 sentences\","
    "\"redactions\":[\"short note on anything sensitive to strip before sharing\"]}")


def propose_audience(otid):
    st = read_state(otid)
    if st is None:
        raise FileNotFoundError(f"no stored conversation {otid}")
    nodes = st.get("nodes", [])
    insights = [{"kind": n["kind"], "topic": n.get("topic"), "good": bool(n.get("good")), "text": n["text"]}
                for n in nodes if n.get("good") or n["kind"] in ("decision", "action_item", "topic")][:40]
    segs = read_segments(otid)
    sample = "\n".join(f"[{s['speaker']}] {s['text']}" for s in segs[:60])
    user = (f"Title: {(st.get('meta') or {}).get('title') or otid}\n\n"
            f"Decoded insights (decisions / action items / good points / topics):\n{json.dumps(insights)}\n\n"
            f"Transcript sample (start of meeting):\n{sample}\n\nReturn JSON only.")
    r = requests.post(NEAR_URL, headers={"Authorization": f"Bearer {NEAR_KEY}", "content-type": "application/json"},
                      json={"model": TEXT_MODEL, "max_tokens": 400, "temperature": 0.2,
                            "response_format": {"type": "json_object"},
                            "messages": [{"role": "system", "content": AUDIENCE_SYS},
                                         {"role": "user", "content": user}]},
                      timeout=90)
    r.raise_for_status()
    return json.loads(r.json()["choices"][0]["message"]["content"])


def set_visibility(otid, visibility):
    if visibility not in ("private", "cohort", "public"):
        raise ValueError(f"bad visibility {visibility!r}")
    st = load_state(otid)
    st["visibility"] = visibility
    save_state(otid, st)
    return visibility


def visibility_of(otid):
    return (read_state(otid) or {}).get("visibility", "private")


def correct(otid, speakers=None, corrections=None):
    """Merge owner correction hints into state: speaker cluster→name map and wrong→right text fixes."""
    st = load_state(otid)
    st.setdefault("speakers", {}); st.setdefault("corrections", [])
    if speakers:
        st["speakers"].update(speakers)
    if corrections:
        st["corrections"] += [c for c in corrections if c.get("wrong")]
    save_state(otid, st)
    return {"speakers": st["speakers"], "corrections": st["corrections"]}


def read_state(otid):
    p = STATE_DIR / f"{otid}.json"
    return json.loads(p.read_text()) if p.exists() else None


def read_segments(otid):
    p = LIVE_DIR / f"{otid}.jsonl"
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


def workflow_graph(otid):
    """The cue/detector pipeline this copilot runs, as a flow-graph, with live counts
    for THIS conversation pulled from STATE. Mirrors graph_state()'s real hooks AND the
    cue-config vocabulary (some detectors defined-but-not-yet-wired)."""
    st = read_state(otid) or {}
    nodes = st.get("nodes", [])
    by_kind = {k: sum(1 for n in nodes if n.get("kind") == k)
               for k in ("topic", "question", "point", "decision", "divergence", "action_item", "aside")}
    n_decisions = by_kind["decision"] + by_kind["action_item"]
    n_good = sum(1 for n in nodes if n.get("good"))
    n_seg = len(read_segments(otid))
    started = bool(st.get("started"))
    announced = len(st.get("announced", []))

    def N(id, label, type, count=None, fired=None, sub=None, status="live"):
        d = {"id": id, "label": label, "type": type, "status": status}
        if count is not None: d["count"] = count
        if fired is not None: d["fired"] = fired
        if sub: d["sub"] = sub
        return d

    nodes_out = [
        N("obs", "transcript.segment", "observation", count=n_seg, sub="live Otter line"),
        N("batch", "batch ≥%d" % DECODE_BATCH, "cue", count=n_seg, sub="DECODE_BATCH gate"),
        N("decode", "decode()", "decoder", count=len(nodes), sub="one NEAR call → typed nodes"),
    ]
    nodes_out += [
        N("k_topic", "topic", "kind", count=by_kind["topic"]),
        N("k_question", "question", "kind", count=by_kind["question"]),
        N("k_point", "point", "kind", count=by_kind["point"]),
        N("k_decision", "decision", "kind", count=by_kind["decision"]),
        N("k_divergence", "divergence", "kind", count=by_kind["divergence"]),
        N("k_action_item", "action_item", "kind", count=by_kind["action_item"]),
        N("k_aside", "aside", "kind", count=by_kind["aside"]),
        N("k_good", "good ✨", "kind", count=n_good),
    ]
    nodes_out += [
        N("a_ping", "📡 ping on start → Matrix", "action", fired=started, sub="once per meeting"),
        N("a_decision", "🟢 decision/action → Matrix", "action", count=n_decisions, fired=n_decisions > 0),
        N("a_good", "✨ good → Matrix + party-ball", "action", count=n_good, fired=n_good > 0),
        N("a_recap", "📍 recap for joiners", "action", sub="/recap-matrix (on request)"),
        N("a_audience", "audience proposer", "action", sub="/audience (human-in-loop)"),
    ]
    # cue-config detectors defined in cue-meeting.config.mjs but not yet wired into this server
    nodes_out += [
        N("c_redaction", "redaction requested", "cue", sub="cue-config, not wired", status="planned"),
        N("c_claim", "unverified claim", "cue", sub="cue-config, not wired", status="planned"),
        N("c_route", "routing requested", "cue", sub="cue-config, not wired", status="planned"),
    ]

    edges = [
        ("obs", "batch"), ("batch", "decode"),
        ("decode", "k_topic"), ("decode", "k_question"), ("decode", "k_point"),
        ("decode", "k_decision"), ("decode", "k_divergence"), ("decode", "k_action_item"),
        ("decode", "k_aside"), ("decode", "k_good"),
        ("k_decision", "a_decision"), ("k_action_item", "a_decision"),
        ("k_good", "a_good"), ("obs", "a_ping"), ("decode", "a_recap"), ("decode", "a_audience"),
        ("obs", "c_redaction"), ("obs", "c_claim"), ("obs", "c_route"),
    ]
    return {"otid": otid, "title": (st.get("meta") or {}).get("title") or otid,
            "started": started, "announced": announced, "n_segments": n_seg,
            "n_nodes": len(nodes), "n_decisions": n_decisions, "n_good": n_good,
            "nodes": nodes_out, "edges": [{"source": s, "target": t} for s, t in edges]}


def conversations(live_sp):
    """List every stored conversation from DATA/state + DATA/live, newest first.
    Always includes the currently-live meeting, even before it has been decoded."""
    live = live_sp["otid"] if live_sp else None
    otids = {p.stem for p in STATE_DIR.glob("*.json")} | {p.stem for p in LIVE_DIR.glob("*.jsonl")}
    if live:
        otids.add(live)
    items = []
    for otid in otids:
        st = read_state(otid) or {}
        nodes = st.get("nodes", [])
        n_seg = sum(1 for _ in (LIVE_DIR / f"{otid}.jsonl").open()) if (LIVE_DIR / f"{otid}.jsonl").exists() else 0
        meta = st.get("meta") or {}
        items.append({
            "otid": otid, "title": meta.get("title") or (live_sp.get("title") if otid == live and live_sp else None) or otid,
            "started_at": meta.get("started_at"), "date": meta.get("date"),
            "visibility": st.get("visibility", "private"),
            "live": otid == live, "n_segments": n_seg, "n_nodes": len(nodes),
            "n_decisions": sum(1 for n in nodes if n.get("kind") in ("decision", "action_item")),
            "n_good": sum(1 for n in nodes if n.get("good"))})
    items.sort(key=lambda x: (x["live"], str(x.get("started_at") or x.get("date") or ""), x["otid"]), reverse=True)
    return items


def transcript(otid):
    st = read_state(otid) or {}
    nodes = st.get("nodes", [])
    topics = [{"id": tid, "label": lbl, "node_ids": [n["id"] for n in nodes if n["topic_id"] == tid]}
              for lbl, tid in (st.get("topics") or {}).items()]
    meta = st.get("meta") or {}
    speakers, corrections = st.get("speakers", {}), st.get("corrections", [])
    segs = read_segments(otid)
    clusters = sorted({s["speaker"] for s in segs} | {n["speaker"] for n in nodes})
    return {"otid": otid, "title": meta.get("title") or otid,
            "segments": apply_hints(segs, speakers, corrections),
            "visibility": st.get("visibility", "private"),
            "topics": topics, "nodes": apply_hints(nodes, speakers, corrections),
            "decisions": [n["id"] for n in nodes if n["kind"] in ("decision", "action_item")],
            "good": [n["id"] for n in nodes if n.get("good")],
            "reflection": meta.get("reflection", {}), "archetype_tl": meta.get("archetype_tl", []),
            "speakers": speakers, "corrections": corrections, "clusters": clusters}


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code); self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def _redirect(self, url):
        self.send_response(302); self.send_header("Location", url); self.end_headers()

    def log_message(self, *a):
        pass

    def _q(self, key):
        return parse_qs(urlparse(self.path).query).get(key, [""])[0]

    def _token(self):
        return self.headers.get("X-Auth-Token") or self._q("token")

    def is_owner(self):
        if not OWNER_TOKEN:
            return True
        t = self._token()
        return bool(t) and hmac.compare_digest(t, OWNER_TOKEN)

    def uid(self):
        """Which user is this? 'owner' (owner token, or auth-disabled dev), else a hashed
        user-token uid, else None (no identity presented yet)."""
        if self.is_owner():
            return "owner"
        ut = self.headers.get("X-User-Token") or self._q("u")
        return users.uid_for(ut, OWNER_TOKEN)

    def share_ok(self, otid):
        if not OWNER_TOKEN:
            return True
        sig = self.headers.get("X-Share-Sig") or self._q("sig")
        return bool(sig) and hmac.compare_digest(sig, share_sig(otid))

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index"):
            return self._send(200, (HERE / "index.html").read_bytes(), "text/html")
        if self.path.startswith("/sharelink"):
            if not self.is_owner():
                return self._send(401, json.dumps({"error": "owner only"}))
            otid = self._q("otid")
            return self._send(200, json.dumps({"otid": otid, "sig": share_sig(otid), "url": share_url(otid)}))
        if self.path.startswith("/transcript"):
            otid = self._q("otid")
            if not (self.is_owner() or self.share_ok(otid) or visibility_of(otid) == "public"):
                return self._send(401, json.dumps({"error": "unauthorized"}))
            try:
                return self._send(200, json.dumps(transcript(otid)))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if self.path.startswith("/conversations"):
            owner = self.is_owner()
            try:
                items = conversations(live_speech_cached(otter()))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
            if not owner:
                items = [c for c in items if c.get("visibility") == "public"]
            return self._send(200, json.dumps(items))
        if self.path.startswith("/connections"):
            uid = self.uid()
            if uid is None:
                return self._send(200, json.dumps({"uid": None, "owner": False, "mechanisms": []}))
            return self._send(200, json.dumps({"uid": uid, "owner": uid == "owner",
                                               "mechanisms": connections.all_status(uid)}))
        if self.path.startswith("/google/auth"):
            # full-page redirect to Google consent; state carries the raw token so the callback
            # (which arrives with no auth header) can re-resolve which user this is for.
            state = self._token() or self._q("u")
            if not state or self.uid() is None:
                return self._send(401, json.dumps({"error": "no user identity (token required)"}))
            return self._redirect(google_app.auth_url(state))
        if self.path.startswith("/google/callback"):
            try:
                uid = users.uid_for(self._q("state"), OWNER_TOKEN)
                google_app.connect(uid, self._q("code"))
                return self._redirect(BASE_URL + "/")
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}), )
        if self.path.startswith("/calendar"):
            uid = self.uid()
            if uid is None:
                return self._send(401, json.dumps({"error": "no user identity"}))
            try:
                return self._send(200, json.dumps(google_app.events(uid)))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if self.path.startswith("/gemini"):
            uid = self.uid()
            if uid is None:
                return self._send(401, json.dumps({"error": "no user identity"}))
            try:
                return self._send(200, json.dumps(google_app.gemini_notes(uid)))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if not self.is_owner():
            return self._send(401, json.dumps({"error": "owner only"}))
        if self.path.startswith("/workflow"):
            try:
                return self._send(200, json.dumps(workflow_graph(self._q("otid"))))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if self.path.startswith("/backfill/status"):
            return self._send(200, json.dumps(BACKFILL))
        if self.path.startswith("/audience"):
            try:
                return self._send(200, json.dumps(propose_audience(self._q("otid"))))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if self.path.startswith("/live"):
            after = int(re.search(r"after=(\d+)", self.path).group(1)) if "after=" in self.path else 0
            try:
                return self._send(200, json.dumps(live_state(after)))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if self.path.startswith("/graph"):
            try:
                return self._send(200, json.dumps(graph_state()))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if self.path.startswith("/frame"):
            u = parse_qs(urlparse(self.path).query).get("u", [""])[0]
            try:
                data, ctype = fetch_frame(base64.urlsafe_b64decode(u).decode())
                return self._send(200, data, ctype)
            except Exception as e:
                return self._send(502, f"{e}", "text/plain")
        return self._send(404, "{}")

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path.startswith("/onboard/otter"):
            # any identified user (owner or hashed user-token) may hand the server their Otter
            # cookie; we validate it via /user before storing — a dead cookie surfaces as an error.
            uid = self.uid()
            if uid is None:
                return self._send(401, json.dumps({"error": "no user identity (token required)"}))
            try:
                sid, csrf = body["sessionid"], body["csrftoken"]
                u = open_session({"sessionid": sid, "csrftoken": csrf}).user
                ident = u.get("email") or u.get("name") or u.get("username") or str(u.get("userid"))
                users.set_mech(uid, "otter", {"sessionid": sid, "csrftoken": csrf, "identity": ident})
                return self._send(200, json.dumps({"connected": True, "identity": ident}))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if self.path.startswith("/gemini/import"):
            uid = self.uid()
            if uid is None:
                return self._send(401, json.dumps({"error": "no user identity"}))
            try:
                return self._send(200, json.dumps(ingest_gemini(uid, body["file_id"], body.get("title"), body.get("date"))))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if not self.is_owner():
            return self._send(401, json.dumps({"error": "owner only"}))
        if self.path == "/recap":
            try:
                return self._send(200, json.dumps(recap(body.get("text", ""), body.get("use_slide", True))))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if self.path.startswith("/correct"):
            try:
                return self._send(200, json.dumps(correct(self._q("otid"), body.get("speakers"), body.get("corrections"))))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if self.path.startswith("/visibility"):
            try:
                v = set_visibility(self._q("otid"), body["visibility"])
                return self._send(200, json.dumps({"otid": self._q("otid"), "visibility": v}))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if self.path.startswith("/backfill"):
            try:
                limit = int(self._q("limit") or 12)
                return self._send(200, json.dumps(start_backfill(limit)))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        if self.path == "/recap-matrix":
            try:
                return self._send(200, json.dumps(recap_to_matrix(body.get("use_slide", True))))
            except Exception as e:
                return self._send(200, json.dumps({"error": f"{type(e).__name__}: {e}"}))
        return self._send(404, "{}")


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    print(f"otter live recap: http://{host}:{PORT}   (text={TEXT_MODEL}, vision={VL_MODEL})")
    ThreadingHTTPServer((host, PORT), H).serve_forever()
