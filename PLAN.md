# PLAN — issue #67 (operator-ask): migrate reddit-karma to shared oauth3Connect

Base: `staging`. One app = one PR (per #67 "one PR per app"). Operator-ask, drained first.

## Why this shape (not a naive swap)
`ShareKit.oauth3Connect` (shipped #66/PR#68) ONLY supports the extension path
(`window.oauth3.connect`); with no extension it throws a terminal "No OAuth3 wallet found"
dead-end — the **exact #9 regression** PR #63 is fixing in timeline-peek. reddit-karma today
hand-rolls BOTH the extension connect AND the no-extension wallet self-provision
(did:key → /api/login → /api/connect → /approve → poll). A blind adoption would delete the
wallet path and regress mobile/no-extension. So the root-cause migration is:

1. **Extend the helper**: `oauth3Connect` runs the wallet self-provision when `window.oauth3`
   is absent (instead of dead-ending), then proceeds to the existing probe/step-up recovery.
   Port reddit-karma's PROVEN wallet flow verbatim. No signature change.
2. **Migrate reddit-karma** onto `ShareKit.oauth3Connect` + `ShareKit.oauth3Read`; delete the
   ~60 lines of duplicated wallet boilerplate. Keep the app-specific read/render/evidence.

This also lays clean groundwork for the #9 fix (helper no longer dead-ends) — but timeline-peek
is NOT touched here (open PR #63 owns it).

## Acceptance (from issue #67, for reddit-karma)
- [x] reddit-karma adopts `oauth3Connect()` and no longer hand-rolls the connect handshake
      (extension OR wallet) — boilerplate deleted, helper used.
- [x] Connect still works (extension path unchanged in behavior; wallet path preserved via helper).
- [x] Step-up recovers / no dead-end; errors render honestly (helper's terminal-error contract).
- [x] Parse-clean (`node --check` on extracted `<script>` of both files).
- [x] Deployed to staging; functional verification via envoy bridge (navigate + evaluate asserting
      the wallet path runs and renders the honest read result, no dead-end) + HTTP transcript.
- [x] Tier-2 walked flow captured (2026-07-27): blocker cleared (build_dataset.py gone; envoy
      `screenshot` readback crash fixed by envoy-browser restart). 3 step PNGs + flow.md committed;
      wallet path obtained real token `tok-reddit-7…`, read returned honest 409 "no jar synced for
      reddit", rendered as a plain error card. Relabeled `needs-e2e` → `ready-to-merge`.

## Files
- `share-kit/share-kit.js` — add wallet self-provision to `oauth3Connect`; bump VERSION 0.2.0→0.3.0.
- `reddit-karma/index.html` — inline updated share-kit; rewrite `onConnect` over the helper;
  delete `walletKey`/`walletSignIn`/`connectViaWallet` + base64/base58 helpers now in the kit.
- `.evidence/issue-67/` — flow.md (Tier-2 walked flow + functional evidence + HTTP transcript) + 01/02/03 PNGs.
