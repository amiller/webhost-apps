# Evidence — otterscope #2 (SDK connect() instead of window.oauth3 — mobile/same-pod)

Issue: amiller/webhost-apps#2 · Branch: `ready-2` → `staging` · **Tier 2** (user-visible flow)
Deployed: webhost-staging `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/otterscope/`
Build pin: page renders `build b8` (only this branch's build string); daemon deploy `2026-08-15T16:32Z`, tree `0f98e7a…+escape-fix`.

## The acceptance, walked

> In a browser profile with no extension (or on a phone), `/otterscope/` no longer shows
> "OAuth3 extension not found" on Connect. It renders the SDK's `approveUrl` as a clickable link,
> and after approving in the signed-in pod room the page lists the owner's real Otter transcript
> titles.

- **No dead-end** — `01-no-extension-connect-enabled.png`: `deadEnd:false` (no "extension not
  found" anywhere), Connect enabled, diag reads *"extension: not loaded — web approve via your
  pod room (mobile/same-pod OK)"*.
- **approveUrl rendered as a clickable link** — `02-approve-link-rendered.png`: real pointer click
  on `#connect` → `<a href="…/oauth3/approve/req-f974f503…">Open your pod room to approve Otter
  access →</a>` + waiting status.
- **Approving in the signed-in pod room** — `03-pod-room-approve.png` (room signed in, request
  pending) → real click on the room's Approve button → `04-pod-room-approved.png` (`status:
  approved`). The handshake then completes **in-page** (`05-connected-token-persisted.png`):
  `✓ connected (saved)`, token `tok-otter-…` (34 chars) in `localStorage`, approve box cleared,
  and it **survives reload** (`E2.afterReload`).
- **"the owner's real Otter transcript titles"** — NOT producible on this box, honestly: the
  staging node reports `jars:[]` (no Otter jar anywhere on staging), and the real jar lives on
  `pod.dstack.soc1024.com` (prod — no prod credentials on this box, per box-inventory; operator-run).
  What IS proven live is the full read path up to its RFC-0008 legible state:
  `06-load-conversations-honest-409.png` — *"your Otter isn't synced to this instance yet — add it
  from a device with the OAuth3 extension (log into otter.ai there), then reconnect"* — a legible
  409, never a dead end. The prod walk (approve + real titles) is commented back to the issue.

> With the extension installed the behaviour is unchanged — the SDK's provider-preferred branch
> is taken and the token still persists in localStorage.

- `07-extension-provider-branch.png`: provider present (`diag: "extension: present
  (provider-preferred)"`), click Connect → **web fallback did NOT fire** (`webFallbackFired:false`)
  and the extension's own in-page approval dialog appeared (the `#oauth3-approve` shadow DOM).
- `08-extension-token-persisted.png`: after approving in the extension dialog → `✓ connected
  (saved)`, token `tok-otter-…` persisted in localStorage. Identical pre-change behavior via the
  identical `prov.connect({node,plugin,app})` call the old code made.

> `otterscope/server.ts` no longer references `window.oauth3` directly.

- `grep -c "window.oauth3" otterscope/server.ts` → **0** (was lines 136/141/152 in the base). The
  only provider detection left is the SDK's own expression (`globalThis.oauth3 ??
  globalThis.window?.oauth3`), ported verbatim inside `oauth3Connect()` — the SDK, not the app,
  decides (RFC 0008). Served HTML also greps 0. `deno check` exit 0; the deployed page's script
  passes `node --check`.

## Walk transcript (envoy bridge — real Brave, real pointer clicks, no CDP; `flock`-serialized)

Full logs: `walk-log.txt` / `walk-log2.txt`. Navigation asserted (`location.href`) before trusting
any frame; every screenshot `test -s` + pixel-checked non-blank (1920×894, stdev 12.8–44.0).

```
A  href=…/otterscope/ · provider suppressed · deadEnd:false · connectEnabled:true
B  click #connect → link …/oauth3/approve/req-f974f503… rendered, status "waiting for approval…"
C  room (same tab): title "Approve access — OAuth3", status pending, signed in (no sign-in link)
D  click room "APPROVE (DEV-MODE)" → status approved          [04]
E  2nd request → server-side approve (same call the room button makes) → poll completes IN-PAGE:
   status "connected — click 'Load conversations'…", who "✓ connected (saved)",
   token tok-otter-… (34 chars) in localStorage, approve box cleared   [05]
E2 reload → still "✓ connected (saved)", token persists
F  click "Load conversations" → honest 409 "add it from a device with the OAuth3 extension…"  [06]
G  extension present → click Connect → webFallbackFired:false, extension dialog shown  [07]
G  approve in extension dialog → token tok-otter-… persisted, "✓ connected (saved)"   [08]
```

## Honest notes on method

1. **Driving the no-extension branch:** the bridge Brave always carries the oauth3 extension, and
   this box has no second extension-free browser (CDP browsers are banned — LESSONS 2026-07-02).
   So the phone path was driven by suppressing the provider global in-session
   (`window.oauth3 = undefined`, then the page's own `diag()` re-run) — the SDK's provider
   detection then fails exactly as on a phone and the web fallback runs. Same code path; stated
   plainly, not decorated around.
2. **Single-tab artifact:** the rig drives one tab; navigating it to the pod room unloads
   otterscope's poll (request #1's token can't land in-page). Real users get `target=_blank` on
   the link. The in-page completion was therefore proven on a second request approved through the
   exact server call the room's Approve button makes (`POST /api/connect/:id/approve`, Bearer
   session) — and the room's real button itself was clicked and approved in step D.
3. **Room double-fire artifact:** after the room's Approve succeeds, the rig's 5-event click
   sequence synthesizes a second activation → the room prints "unknown or already-decided
   request" under the `approved` status. First POST approves; the duplicate 404s. Outcome correct;
   shown, not hidden.
4. **Approver identity:** the staging room was signed in with the rig wallet key
   (`~/.paseo-secrets/swarm-userkey`; staging derives subject `u-eaf13541…` — the spec's
   `u-cc7f19…` subject is the prod node's derivation).
5. **Redaction:** scoped staging tokens shown as `tok-otter-…` prefix only; no personal data was
   rendered anywhere in this walk (staging has no Otter jar — hence the 409 state, which is the
   honest value-state for this box).
6. **Screenshot review:** content of each frame is asserted by DOM evaluation (`innerText`,
   `href`, `style.display`) at the asserted URL; captures are pixel-verified non-blank. The
   worker model on this box cannot render images, so the DOM assertions — pasted above — are the
   content proof.

## What is NOT verified here (operator-run remainder)

- Deploy `b8` to **prod** `https://pod.dstack.soc1024.com/otterscope/` (tarball deploy needs prod
  `TEE_DAEMON_TOKEN`; none on this box by design).
- The **owner's real Otter transcript titles** listing (needs the prod node's synced otter jar;
  per LESSONS 2026-07-11 that screenshot must stay out of this public repo anyway — verify
  in-session, commit a labeled sample).

Both are commented back on issue #2.
