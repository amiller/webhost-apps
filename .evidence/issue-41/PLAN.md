# PLAN — issue #41 (follow-up: honest reddit-karma evidence signal)

## Context
#41 ("evidence walk reads REGISTRY.md") shipped via merged PR #43 (merge `832dae64`, on
`origin/staging`). The `ready` label was re-added by the operator **5× on 2026-07-28** after four
worker noop-stops — i.e. the operator wants #41 driven to actually-done, not another "it's merged"
stop. The concrete unfinished thread the owner flagged on 07-09: **reddit-karma's staging evidence
signal FAILED**.

## Root cause (verified against `origin/staging` + live URL, not trust)
- REGISTRY.md `Expected` for reddit-karma = `` title "Reddit Karma" ``
- reddit-karma `index.html` (source, origin/staging) = `<title>Reddit Saved</title>`; `<h1>Reddit Saved</h1>`
- Live staging page today = HTTP 200, `<title>Reddit Saved</title>`
- The app renders the account's **saved posts** (`GET /oauth3/api/reddit/items`); the `/account`
  karma route "was never shipped and 404s — #64". "Reddit Saved" is the true identity; the directory
  name `reddit-karma` is legacy. The registry `Expected` cell was stale/aspirational — violating #41's
  own contract printed in REGISTRY.md: *"never put a fake or aspirational signal here — only one
  verified against the live page."*

## Acceptance (from the issue)
> Add a REGISTRY.md row for a test app: the next /journeys refresh shows a card for it with a real
> screenshot and PASS/FAIL against the row's expected signal, with zero host-side edits.
> reddit-karma appears in /journeys via its own row.

The row exists (#43); the gap was the **FAIL**. This fix makes the signal honest so it **PASSes**.

## Checkboxes
- [x] Fix reddit-karma `Expected`: `title "Reddit Karma"` → `title "Reddit Saved"` (matches live page)
- [x] Correct the stale `Notes` cell (claimed "reads karma"; karma route 404s — #64) so the row is truthful end-to-end
- [x] `registry-evidence.sh --file REGISTRY.md` parses; reddit-karma emits the new signal
- [x] Live staging page title === "Reddit Saved" (curl, HTTP 200)
- [x] Browser bridge: `location.href` verified, `document.title === "Reddit Saved"`, exact signal evaluator → `true`
- [x] Screenshot captured (non-empty, `test -s` ✓)

## Tier
**Tier 0** — no app/API behavior change; one data cell in REGISTRY.md (+ its Notes). The change's
*purpose* is to make the evidence-walk signal honest/PASSing, proven by the transcript below.
