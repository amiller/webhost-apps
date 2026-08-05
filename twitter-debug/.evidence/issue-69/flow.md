# #69 — twitter-debug: name the target account when connecting (multi-account jars)

## Acceptance (from the issue)
twitter-debug binds to a named twitter account instead of assuming the subject has exactly one
jar. All three, on deployed staging:

1. An `ACCOUNT` env/config value is passed as `account` in the `POST /api/connect` body, and the
   app acts as that account.
2. A 409-with-accounts response is handled by logging the available accounts — not an opaque
   failure. Show the log line from a real 409.
3. The consent line names the account it will act as, not just the plugin.

Evidence: Tier 2 — a screenshot of the consent line naming the account, plus the 409 log line.

---

## How it was verified (and the one environmental gap)

**Setup.** twitter-debug is a `runtime=image` app (docker build + ghcr push + tee-daemon). The ghcr
push creds are NOT on this box (box-inventory: "Not here: ghcr push credentials"), so redeploying
twitter-debug to webhost-staging is an **operator-run** step. To verify the code on this box, the
real `server.ts` was booted under tsx against a **real local oauth3-server instance**
(`~/projects/oauth3-server`, the same code that runs on staging) with **synthetic** twitter jars
(twid `u=111` / `u=222`, fake auth tokens — NOT real personal data). All HTTP transcripts below are
real requests against that real oauth3-server + real twitter-debug `refreshJar`/`startConnect` code.

### Bullet 1 — account in connect body + app acts as that account  (Tier 1, real)
With `ACCOUNT=111`, `/twitter/oauth3/status` returns `"account":"111"`. Calling
`POST /twitter/oauth3/connect` → `startConnect()` → the connect request **stored by the real
oauth3-server** carries `"account":"111"` (read from `connect.json`; see
`bullet1-connect-account.txt`). After owner approval, twitter-debug's `refreshJar` loaded account
**111's** jar (3 cookies) — not 222's:
```
[oauth3] connected — jar refreshed (3 cookies)
```
See `bullet1-connect-account.txt`.

### Bullet 2 — 409-with-accounts handled by logging the accounts  (Tier 1, real)
With the subject holding two synthetic twitter accounts and the token bound to none,
`GET /api/twitter/jar` returns a real 409:
```
{"error":"multiple accounts synced for twitter; pass ?account=<id> or bind the token to one","accounts":["111","222"]}  [HTTP 409]
```
twitter-debug's real `refreshJar()` received it and logged the accounts instead of failing opaquely:
```
[oauth3] 409: multiple twitter accounts synced for the subject — set ACCOUNT to one of: 111, 222
```
The `/twitter/oauth3/refresh` response is likewise non-opaque:
`multiple twitter accounts synced — set ACCOUNT to one of: 111, 222`. See `bullet2-409-log.txt`.

### Bullet 3 — consent line names the account  (real-browser DOM assertion; PNG blocked)
The dashboard (`web/index.html`) now exposes the account in card ② and the connect-flow line.
Driven in the **real envoy/neko Brave browser** (bridge `navigate` + `evaluate`):
```
location.href        = http://172.17.0.1:8931/twitter-debug/
ACCT (page global)   = "111"
#act-as.textContent  = "twitter-debug will act as twitter account 111"
lockpill             = "🔓 writes on"   (WRITES=true, i.e. connected as account 111)
sync XHR /twitter/oauth3/status → 200 {"connected":true,...,"account":"111"}
```
So the consent line **does** name the account (`twitter account 111`), asserted against the live DOM
in the real browser. See `bullet3-consent-evaluate.txt`.

**PNG gap (environmental).** The envoy bridge's **screenshot capture** tool was timing out on every
page — including `about:blank` and a trivial `data:` page — across 15+ attempts (navigate and
evaluate work; only screenshot hangs, 30 s `Command timeout` from the extension side). No host
renderer exists on this box (no chromium/chrome/wkhtmltoimage/puppeteer). So the Tier-2 **PNG of the
consent line could not be captured this run** — it is the one remaining artifact. The consent-line
content itself is proven above via the real-browser DOM assertion. PR is labelled `needs-e2e` for
the screenshot; it is NOT `ready-to-merge` until that PNG lands.

## Operator steps remaining
1. **Redeploy twitter-debug** to webhost-staging (ghcr push + tee-daemon — operator-run from this
   box) with `ACCOUNT=<bot twitter id>` in the project env.
2. **Capture the consent-line PNG** via the envoy bridge once its screenshot capture recovers (or on
   a box where it works), signed in as `u-swarm`, and attach to this PR — then flip `needs-e2e` →
   `ready-to-merge`.
3. The 409 log line is already proven against a real oauth3-server; on staging it will fire for real
   the first time a multi-account subject connects without `ACCOUNT` set.

## Diff
- `twitter-debug/server.ts`: read `ACCOUNT` env → `TWITTER_ACCOUNT`; send it as `account` in the
  `POST /api/connect` body; handle 409-with-accounts in `refreshJar` (log + rethrow the accounts);
  expose `account` in `/twitter/oauth3/status`.
- `twitter-debug/web/index.html`: consent line (`#act-as`) names the account; the connect-flow
  status line names the account; `pollConn` populates it from status.
