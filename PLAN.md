# PLAN — otterscope #2: SDK connect() instead of window.oauth3 directly (mobile/same-pod)

Issue: amiller/webhost-apps#2 · base `staging` · **Tier 2** (user-visible flow).

## Acceptance (from issue #2, verbatim)
> - [ ] In a browser profile with no extension (or on a phone), `/otterscope/` no longer shows
>   "OAuth3 extension not found" on Connect. It renders the SDK's `approveUrl` as a clickable
>   link, and after approving in the signed-in pod room the page lists the owner's real Otter
>   transcript titles.
> - [ ] With the extension installed the behaviour is unchanged — the SDK's provider-preferred
>   branch is taken and the token still persists in localStorage.
> - [ ] `otterscope/server.ts` no longer references `window.oauth3` directly (currently lines 88 and 93).

## Implementation shape
Port `oauth3-sdk connect()` (canonical: `feedling-web/sdk/index.ts`, RFC 0008) into the page —
otterscope is a single self-contained file (no build, no imports), same as feedling-web's
`oauth3-client.ts` hand-drives the identical handshake. share-kit's `oauth3Connect` is NOT used:
its no-extension path is wallet self-provision (fresh did:key identity), which would mint a token
with no Otter jar; #2's acceptance demands the SDK's web fallback (`approveUrl` → approve in the
signed-in pod room → poll), which is what a phone user and the owner's synced jar need.

## Tasks
- [x] Pre-flight: #2 open, `ready`, no open PR, `## Acceptance` present (merge-gate grep) — PASS
- [x] Port SDK `connect()`: provider-preferred branch (wallet carries flow) + web fallback
      (POST /api/connect → `onApproveUrl` → poll `/api/connect/:id`)
- [x] Render `approveUrl` as a clickable link (target=_blank) + waiting status; clear on connect/logout
- [x] Remove the extension dead-end: diag() line honest for both paths (no more "NOT FOUND" framing)
- [x] 409 read message names the faucet honestly (RFC 0008: legible, never a dead end)
- [x] README/REGISTRY: drop "extension-dependent" notes; document both paths
- [x] `deno check otterscope/server.ts` — exit 0
- [x] Deploy to webhost-staging (staging project was a stale 2026-06-26 deploy 404ing — refreshed)
- [x] Tier 2 walk on the deployed staging URL (envoy bridge, flock-serialized, real pointer clicks):
      01 no-extension Connect enabled (no dead-end) · 02 approve link rendered · 03 pod-room approve
      page signed in (u-swarm) · 04 connected + token in localStorage + honest 409 on Load conversations
- [x] Evidence committed to `.evidence/issue-2/` + `flow.md`; PR body embeds the step screenshots
- [ ] PROD-only remainder (operator-run — no prod creds on this box, per box-inventory):
      deploy to pod.dstack.soc1024.com and read the owner's real Otter transcript titles (needs the
      prod otter jar; staging has `jars:[]`). Commented back to issue #2.
