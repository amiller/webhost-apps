# Evidence — issue #41 follow-up (honest reddit-karma signal)

**Tier 0** (no app/API behavior change — one REGISTRY.md data cell). The change makes reddit-karma's
evidence-walk signal match its live page so the row PASSES instead of FAILs. Acceptance line being
satisfied: *"reddit-karma appears in /journeys via its own row"* with a signal that now PASSes.

## The diff (one row of REGISTRY.md)
- `Expected`: `` title "Reddit Karma" `` → `` title "Reddit Saved" ``
- `Notes`: "reads the Reddit account's karma …" → "reads the Reddit account's **saved posts** …
  (`GET /oauth3/api/reddit/items`; the `/account` karma route was never shipped and 404s — #64)"

## (1) registry-evidence.sh parses MY edited file → emits the corrected signal
```
$ bash scripts/registry-evidence.sh --file REGISTRY.md --app reddit-karma
reddit-karma|https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/reddit-karma/|title "Reddit Saved"|sample OAuth3 app ... rendered title Reddit Saved ...|
```
Whole-file parse: `parse OK, 11 rows emitted` (no errors).

## (2) LIVE reddit-karma staging page today (the signal target) — raw-fetch probe
```
$ curl -s -o /tmp/rk.html -w 'HTTP=%{http_code} bytes=%{size_download}\n' -L <Evidence URL>
HTTP=200 bytes=42286
<title>Reddit Saved</title>
```

## (3) Browser bridge — exactly what the walk does (evaluate document.title)
Driven via the envoy bridge (`POST http://localhost:3000/api/bridge`), real browser:
```
navigate   → {"success":true,"result":{"success":true}}
location.href → "https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/reddit-karma/"   (navigation verified, not silent)
document.title → "Reddit Saved"
exact signal evaluator (from registry-evidence.sh header) applied to `title "Reddit Saved"` → true   (PASS)
```

## Screenshot
`reddit-karma-staging.png` (1912×996, 33744 B, `test -s` ✓). NOTE: captured as supporting visual
context; the page CONTENT was verified via `evaluate(document.title)` and the raw HTML (the operator
agent cannot visually render images), so the PASS rests on the title evaluation above, not a visual
read. A blank/placeholder image is forbidden by LESSONS; this one is non-empty and the title eval
proves it is the reddit-karma page, not a lobby/404.

## What I could NOT verify (honest)
- The zed-side `apps-evidence.sh` re-run that actually stamps the `/journeys` card PASS — that is the
  operator-run, zed-side half of #41 (out of this repo/lane). I verified the webhost-apps half it
  consumes: the registry row is correct AND the live page satisfies the signal, so the next walk will
  PASS. The 07-09 staging FAIL is resolved at its root cause (stale signal), not masked.
- I did not re-audit the other 10 rows' signals (out of this issue's reddit-karma acceptance scope);
  this PR is the minimal fix for the failing, acceptance-named row.
