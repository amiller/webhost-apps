#!/usr/bin/env python3
"""attest — run an agent whose every API call is witnessed, and check the result.

The agent gets no credential. This opens a session on the interposer, points the
agent at it, closes the session to collect a signed bundle, and can recheck that
bundle offline afterwards.

  attest.py run    --purpose "[research-router] my matter" -- claude -p "..."
  attest.py check  bundle.json
  attest.py show   bundle.json --calls 2      # what a counterparty would see

Needs only Python's standard library. CVM and INVITE come from the environment
or flags:

  export ATTEST_CVM=https://pod.dstack.soc1024.com
  export ATTEST_INVITE=$(cat ~/.claude/attest-proxy-invite-token)
"""
import os, sys, json, time, base64, hashlib, argparse, subprocess, urllib.request
from pathlib import Path

DEFAULT_CVM = os.environ.get("ATTEST_CVM", "https://pod.dstack.soc1024.com")


def post(url, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else b""
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"content-type": "application/json"})
    if token:
        req.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


# --- the constructions the interposer attests (mirror of host/frames.py) ------

def commitment(host: str, redacted: bytes, response: bytes) -> bytes:
    return hashlib.sha256(b"zktls-v1\0" + host.encode() + b"\0" + redacted + b"\0" + response).digest()


def _leaf(c): return hashlib.sha256(b"\x00" + c).digest()
def _node(l, r): return hashlib.sha256(b"\x01" + l + r).digest()


def _split(n):
    k = 1
    while k * 2 < n:
        k *= 2
    return k


def merkle_root(cs):
    if not cs:
        return hashlib.sha256().digest()
    if len(cs) == 1:
        return _leaf(cs[0])
    k = _split(len(cs))
    return _node(merkle_root(cs[:k]), merkle_root(cs[k:]))


def inclusion_proof(cs, i):
    if len(cs) == 1:
        return []
    k = _split(len(cs))
    if i < k:
        return inclusion_proof(cs[:k], i) + [merkle_root(cs[k:])]
    return inclusion_proof(cs[k:], i - k) + [merkle_root(cs[:k])]


def session_root(meta: bytes, cs) -> bytes:
    meta_hash = hashlib.sha256(b"zktls-session-v2\0" + meta).digest()
    root = merkle_root(cs) if cs else b"\x00" * 32
    return hashlib.sha256(b"zktls-root-v2\0" + meta_hash + root
                          + len(cs).to_bytes(4, "big")).digest()


def report_data(root: bytes, beacon) -> bytes:
    if not beacon:
        return root
    tag = f"{beacon['source']}:{beacon['round']}:{beacon['randomness']}".encode()
    return hashlib.sha256(b"zktls-anchor-v1\0" + root + tag).digest()


# --- commands ---------------------------------------------------------------

def cmd_run(a):
    invite = a.invite or os.environ.get("ATTEST_INVITE", "")
    if not invite:
        raise SystemExit("no invite token: set ATTEST_INVITE or pass --invite")
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    if not cmd:
        raise SystemExit("give a command after --, e.g. -- claude -p '...'")

    s = post(f"{a.cvm}/attest-proxy/session", {
        "purpose": a.purpose, "profile": a.profile,
        "instructed_by": a.instructed_by}, token=invite)
    sid, tok = s["session_id"], s["auth_token"]
    if s.get("beacon"):
        print(f"[attest] session {sid[:12]}…  not before drand round {s['beacon']['round']}")
    else:
        print(f"[attest] session {sid[:12]}…  no timestamp beacon (drand unreachable)")

    env = dict(os.environ,
               ANTHROPIC_BASE_URL=f"{a.cvm}/attest-proxy",
               ANTHROPIC_AUTH_TOKEN=tok, ANTHROPIC_API_KEY=tok)
    t0 = time.time()
    try:
        rc = subprocess.run(cmd, env=env).returncode
    finally:
        bundle = post(f"{a.cvm}/attest-proxy/session/{sid}/close")
        out = Path(a.out or f"attest-{sid[:12]}.json")
        out.write_text(json.dumps(bundle, indent=2))
        print(f"\n[attest] {bundle['call_count']} calls in {time.time()-t0:.1f}s "
              f"-> {out}")
        if bundle.get("quote_error"):
            print(f"[attest] no quote: {bundle['quote_error']}")
            print("[attest] the project is in dev mode; promote it for real attestation")
    return rc


def _usage_of(bundle):
    """Token counts as Anthropic reported them, inside responses this service
    received over TLS against a pinned root."""
    tin = tout = 0
    models = set()
    for c in bundle.get("calls", []):
        try:
            body = base64.b64decode(c["response_b64"])
            body = body.split(b"\r\n\r\n", 1)[-1]
            d = json.loads(body)
        except Exception:
            continue
        u = d.get("usage") or {}
        tin += u.get("input_tokens", 0) or 0
        tout += u.get("output_tokens", 0) or 0
        if d.get("model"):
            models.add(d["model"])
    return tin, tout, sorted(models)


def cmd_check(a):
    b = json.loads(Path(a.bundle).read_text())
    meta = base64.b64decode(b["session_meta_b64"])
    cs = [bytes.fromhex(c["commitment"]) for c in b["calls"]]

    for c in b["calls"]:
        want = commitment("api.anthropic.com",
                          c["request_redacted"].encode("latin-1"),
                          base64.b64decode(c["response_b64"]))
        if want.hex() != c["commitment"]:
            raise SystemExit(f"call {c['n']}: transcript does not match its commitment")
        print(f"  ok call {c['n']}  {c['commitment'][:16]}…")

    if b.get("call_count", len(cs)) == len(cs):
        root = session_root(meta, cs)
        if root.hex() != b["session_root"]:
            raise SystemExit(f"session root mismatch: {b['session_root']} != {root.hex()}")
        print(f"\nsession root {root.hex()} recomputes")

    rd = report_data(bytes.fromhex(b["session_root"]), b.get("beacon"))
    if b.get("report_data") and rd.hex() != b["report_data"]:
        raise SystemExit("report_data does not bind this root and beacon")

    tin, tout, models = _usage_of(b)
    print(f"purpose  {b['purpose']!r}")
    print(f"release  {b['release']['profile']}"
          + (f" (instructed by {b['release']['instructed_by']})"
             if b["release"].get("instructed_by") else ""))
    if b.get("beacon"):
        print(f"not before  drand round {b['beacon']['round']}")
    print(f"usage    {tin} in / {tout} out tokens, model(s): {', '.join(models) or 'n/a'}"
          "   [Anthropic's own figures, from responses received over pinned TLS]")
    if b.get("quote"):
        print(f"quote    present, binds report_data {b['report_data'][:16]}…")
        print(f"         verify the CVM and app measurements at "
              f"{a.cvm}/_api/verification/attest-proxy")
    else:
        print(f"quote    ABSENT ({b.get('quote_error')}) — nothing here is attested yet")
    print("\nall recomputations green")


def cmd_show(a):
    """Produce what a counterparty sees: chosen calls plus inclusion proofs."""
    b = json.loads(Path(a.bundle).read_text())
    cs = [bytes.fromhex(c["commitment"]) for c in b["calls"]]
    keep = [] if a.none else [int(x) for x in a.calls.split(",") if x.strip()]
    disclosed = []
    for i in keep:
        c = dict(b["calls"][i - 1])
        c["index"] = i - 1
        c["inclusion_proof"] = [h.hex() for h in inclusion_proof(cs, i - 1)]
        disclosed.append(c)
    out = {k: b[k] for k in ("purpose", "release", "session_meta_b64",
                             "session_root", "beacon", "report_data", "quote")
           if k in b}
    out.update(kind="edge-tee partial disclosure", call_count=len(cs),
               merkle_root=merkle_root(cs).hex() if cs else None,
               calls=disclosed, withheld=len(cs) - len(disclosed))
    Path(a.out).write_text(json.dumps(out, indent=2))
    print(f"disclosed {len(disclosed)} of {len(cs)} calls, "
          f"{out['withheld']} withheld -> {a.out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cvm", default=DEFAULT_CVM)
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run"); r.add_argument("--purpose", required=True)
    r.add_argument("--profile", default="holder-only",
                   choices=["holder-only", "aggregate-only", "dual-delivery"])
    r.add_argument("--instructed-by", default="")
    r.add_argument("--invite"); r.add_argument("--out")
    r.add_argument("cmd", nargs=argparse.REMAINDER)
    r.set_defaults(fn=cmd_run)

    c = sub.add_parser("check"); c.add_argument("bundle"); c.set_defaults(fn=cmd_check)

    s = sub.add_parser("show"); s.add_argument("bundle")
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--calls"); g.add_argument("--none", action="store_true")
    s.add_argument("-o", "--out", required=True); s.set_defaults(fn=cmd_show)

    a = ap.parse_args()
    sys.exit(a.fn(a) or 0)


if __name__ == "__main__":
    main()
