# share-kit

One shared capability-share UI for the whole webhost-app suite. The apps on this pod are
all one primitive — *share a scoped, revocable capability over something that's mine,
without handing over the credential* — and share-kit is the small shared UI that makes
that shape visible and consistent, so learning one app teaches all of them.

It exports **three pieces** (plus the `ShareHandle` that wires them together), and the
**connect half** every relying-party app needs to obtain the scoped token in the first place:

1. **`ShareKit.shareAction(el, {label, onShare, onShared})`** — the primary button,
   labeled by the *journey* (`Share my feed →`, `Let someone edit this event →`,
   `Share this live meeting →`). Never "mint token" / "connect".
2. **`ShareKit.capabilityReceipt(el, handle)`** — shown after sharing: the `?token=` link,
   a **plain-English scope sentence**, a **Revoke** control, and a **status pill**
   (`active` / `revoked` / `expired`).
3. **`ShareKit.recipientBanner(el, handleOrOpts)`** — top strip on a shared view:
   *"You're viewing \<owner>'s shared \<thing> · \<capability>"*, with an **honest
   end-state** when revoked / expired / gone (anti-hollow-green, applied to UX).
4. **`ShareKit.oauth3Connect({plugin, app, node, onStatus, probe})`** → `Promise<token>` —
   the shared connect handshake. Runs `window.oauth3.connect()`; if a `probe(token)` is
   given it then runs the gated read and treats a **409 `challenge_pending` / step-up as
   retryable** — fires `onStatus("waiting-approval")`, polls `GET /api/challenge/:id`
   (capped ~20×4s, mirroring otterpilot's proven #61 recover), and re-runs the probe on
   approval. **Every other failure is terminal and re-thrown** so the app renders the REAL
   error — no raw dead-end, no mock/mask. `ShareKit.oauth3Read(node, path, token)` is the
   gated-read primitive the probe calls (throws the step-up marker on 409 `challenge_pending`,
   a terminal `Error` carrying the node's real `{error}` otherwise). This is the fix for the
   bug where timeline-peek dead-ended on a raw `challenge_pending` string.

```js
ShareKit.init();                                   // inject <style> once
const h = ShareKit.handle({                         // observable share state
  link, scope, owner, thing, capability, status,    //   link scope owner thing capability status
  onRevoke: async () => { /* DELETE /api/tokens/:t */ }
});
ShareKit.shareAction(shareEl, {
  label: "Share my feed →",
  async onShare() { /* mint the token */ return ShareKit.handle({ … }); },
  onShared(h) { ShareKit.capabilityReceipt(receiptEl, h); }
});
ShareKit.recipientBanner(bannerEl, h);              // stays in sync with h.revoke()
```

## Design system — it inherits your app's inking

share-kit is a **component** layer, not a token layer (exactly like the pod's
`components.css`). It CONSUMES the host app's pod design tokens at `:root`
(`--ink1` / `--ink2` / `--paper` / `--deep` / `--wash1` / `--wash2` / `--i1-text` /
`--i2-text` / `--warn` / `--warn-wash` / `--block` / `--block-text` / `--rule` /
`--faint` / `--card` / `--cond` / `--mono` / `--sans` / `--off`) — so it renders in each
app's own inking (watermelon classic, grape-acid webhost, …) and light/dark register.

**Your app must already define those tokens** (inline `tokens.css` / your `:root` block —
every pod app already does). share-kit defines none of its own. All its styles are scoped
under `.sk` and every class is `.sk-*`, so it never collides with a host app's own
`.btn` / `.pill` / `.card` classes.

See `index.html` here for the living reference (all three pieces, fake mint/revoke, and a
grape-acid re-ink panel demonstrating token inheritance). It's deployed to webhost-staging
at `<staging-cvm>/share-kit/` for review.

## The scope sentence must be TRUE

`handle.scope` names exactly what the token can and cannot do — review it for honesty per
app. So far:

| app | scope sentence | true because |
|---|---|---|
| timeline-peek | `read-only · your X For-You feed · nothing else` | the minted twitter token only ever calls `GET /api/twitter/feed` |
| calendar-share (future) | `edit · one calendar event (write:event:<id>) · nothing else on the calendar` | the cap is `write:event:<id>`, enforced exactly server-side |
| otterpilot (future) | `read-only · this live meeting, until it ends` | scoped otter read, bounded by meeting lifetime |

## Honesty on Revoke

`handle.onRevoke` should perform the **real** revoke server-side and resolve only once
confirmed (e.g. `DELETE /api/tokens/:token`). If it throws, share-kit does **not** flip
the pill to `revoked` — the receipt re-enables and surfaces the real error. The recipient
banner subscribes to the same handle, so an owner-side revoke flips the recipient view to
the honest revoked state on its next render.

## Adopt (inline the one file)

These apps deploy as **single-file static projects**: the webhost runtime serves only the
entry file at the project mount root (e.g. `/timeline-peek/` → `index.html`; every other
path 404s), so a shared kit can't be `<script src=` from a sibling file — it has to live
*inside* the app's one `index.html`. (That's how every static app here is already written:
self-contained, no build.)

The SAME `inline.sh` inlines both halves (share UI + connect helper), so an app that only
needs `oauth3Connect` still inlines the canonical file once and uses just that piece — the
share-UI CSS is scoped under `.sk` and inert until an app calls it. `inline.sh` wraps the
canonical `share-kit/share-kit.js` into a marked block in an app's `index.html`, so re-running
it picks up kit updates without hand-merging:

```bash
./share-kit/inline.sh timeline-peek     # inlines/updates the <!--share-kit:inline--> block
```

The canonical source is `share-kit/share-kit.js`. The inlined block is wrapped in a
`<!-- share-kit:inline … -->` marker comment carrying the canonical path + version, and
`inline.sh` escapes any `</script` sequence in the kit so the inlined `<script>` block
can't be closed early by the HTML parser.

## Adopted so far

- **timeline-peek** — first connect-half adopter (this PR). Its owner-mode Connect button
  now goes through `ShareKit.oauth3Connect` with a `probe` that reads
  `/api/twitter/feed` via `ShareKit.oauth3Read`: a step-up shows "waiting for approval…"
  and recovers on approval; a down twitter backend (browser-SPI) surfaces an honest,
  readable error instead of the old raw `challenge_pending` dead-end. (The share-UI half
  is inlined too and available for the `?token=` share mode in a follow-up.)
- **otterpilot** — inlines the share-UI half for its owner-side "Share this live meeting"
  receipt + the follow recipient banner; its live poll has its own proven challenge-recover
  loop (server-side token, #61/#62).
- **calendar-share** — to follow, built against this kit so the suite is consistent by
  construction.
