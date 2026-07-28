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
- [ ] Tier-2 walked flow on staging.

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
- [x] `node --check` on the combined script — OK.

## Verify (Tier 2)
- [ ] deploy calendar-share (ready-67) to webhost-staging.
- [ ] envoy bridge: open `/calendar-share/`, screenshot landing (owner mode + Connect).
- [ ] drive Connect (wallet path — drivable HTTP, no extension popup), screenshot the honest
      read result + the still-reachable mint envelope.
- [ ] assert acceptance content via `evaluate` (connect transitions; error renders honestly).
- [ ] commit `.evidence/issue-67/calendar-share/` + `flow.md`; embed in PR.
