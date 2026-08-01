# PLAN — #67 (calendar-share): adopt ShareKit.oauth3Connect

Issue #67 is a meta-issue, **one PR per app** (reddit-karma shipped via #74). This PR is
**calendar-share** — the next app that genuinely hand-rolls the browser connect handshake.
(feedling-web's connect is server-side via its own SDK poll loop, not `window.oauth3`, so
the browser helper doesn't fit it without a rearchitecture; otterpilot already inlines an
older share-kit + a working step-up; screenshare-debug is an outbound UCAN consent app, not
a connect+read relying party. calendar-share is the pure target.)

## Acceptance (from #67, for calendar-share)
- [x] adopts `ShareKit.oauth3Connect()`; no longer hand-rolls the handshake.
- [x] connect works (extension path OR wallet self-provision, via the shared helper).
- [x] step-up / no dead-end: `oauth3Read`'s step-up marker is surfaced as an actionable
      retry message, NOT a raw `challenge_pending` string (the bug the helper fixes). The
      helper's automatic probe-loop recovery is available once the google-calendar read goes
      live; today the read returns "not yet captured" (not 409), so the step-up branch is
      documented + code-present, not live-exercised.
- [x] errors render honestly (helper's terminal Errors + the read's real error shown verbatim).
      **Reinforced this pass:** `_walletSignIn`'s challenge `.json()` no longer leaks a raw parse
      error on a non-JSON node response (e.g. the current staging 500) — it throws a clean
      `login <status>` like every other step. Walked in-page (`.evidence/…/03-*.png`).
- [~] Tier-2 walked flow on staging — **partial, honestly stuck**: walked page-serves (01),
      connect-takes-extension-branch (02), and wallet-path→clean-honest-error/no-dead-end (03).
      `connect` **success** remains unwalkable: staging `/oauth3` is 500 (infra) **and**
      `calendar-share` is not listed on the prod node (operator). Both re-verified live.

## Build
- [x] share-kit v0.4.0: `oauth3Connect` + `_connectViaWallet` forward `caps` (mint path).
- [x] `inline.sh`: resolve entry html at `<app>/index.html` OR `<app>/public/index.html`.
- [x] inline share-kit (v0.4.0) into `calendar-share/public/index.html`.
- [x] `onConnect` → `ShareKit.oauth3Connect` (pure-handshake: the read path isn't live, and
      gating connect on it would regress the mint envelope that is this app's value today).
- [x] `loadEvents` → `ShareKit.oauth3Read` (+ step-up vs terminal handling).
- [x] `mintShare` → `ShareKit.oauth3Connect({caps:[cap]})`.
- [x] remove ~60 lines of hand-rolled wallet self-provision (walletKey/walletSignIn/
      connectViaWallet + the b58/did:key crypto).
- [x] `revokeShare` reuses ShareKit's persisted `oauth3_session`.
- [x] `node --check` on the combined script — OK (re-run after the hardening below: OK).
- [x] **harden wallet error render** (rework pass 2): `_walletSignIn` `/api/login/challenge` was
      the only uncaught `.json()` in the connect path — a non-JSON 500 leaked `Unexpected token…`.
      Now parses with `.catch(()=>({}))` + `if(!lr.ok) throw "login "+status`, matching the
      adjacent `/api/login` POST. Source `share-kit.js` edited, `inline.sh calendar-share` re-run.

## Verify (Tier 2)
- [x] deploy calendar-share (ready-67) to webhost-staging (tree `d0ed7cd4`, 22:52 UTC).
- [x] envoy rig (HTTP `:4000`, real Brave/neko — no CDP): open `/calendar-share/`, screenshot
      landing (01) + connect-takes-extension-branch (02).
- [x] drive Connect on the **wallet** branch (extension-less), screenshot the **clean** honest
      error render + Connect re-enabled (03) — proves the hardening + "errors render honestly".
- [x] assert acceptance content via `evaluate` (location.href asserted; DOM state at each capture).
- [x] commit `.evidence/issue-67/calendar-share/` + `flow.md`; embed in PR.
- [ ] **connect success** — BLOCKED on staging `/oauth3` 500 (infra) + calendar-share listing
      (operator). Not walkable today; left `needs-e2e`.
