# share-kit

One shared capability-share UI for the whole webhost-app suite. The apps on this pod are
all one primitive — *share a scoped, revocable capability over something that's mine,
without handing over the credential* — and share-kit is the small shared UI that makes
that shape visible and consistent, so learning one app teaches all of them.

It exports **three pieces** (plus the `ShareHandle` that wires them together):

1. **`ShareKit.shareAction(el, {label, onShare, onShared})`** — the primary button,
   labeled by the *journey* (`Share my feed →`, `Let someone edit this event →`,
   `Share this live meeting →`). Never "mint token" / "connect".
2. **`ShareKit.capabilityReceipt(el, handle)`** — shown after sharing: the `?token=` link,
   a **plain-English scope sentence**, a **Revoke** control, and a **status pill**
   (`active` / `revoked` / `expired`).
3. **`ShareKit.recipientBanner(el, handleOrOpts)`** — top strip on a shared view:
   *"You're viewing \<owner>'s shared \<thing> · \<capability>"*, with an **honest
   end-state** when revoked / expired / gone (anti-hollow-green, applied to UX).

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

`inline.sh` inlines the canonical `share-kit/share-kit.js` into a marked block in an app's
`index.html`, so re-running it picks up kit updates without hand-merging:

```bash
./share-kit/inline.sh timeline-peek     # inlines/updates the <!--share-kit:inline--> block
```

The canonical source is `share-kit/share-kit.js`. The inlined block is wrapped in a
`<!-- share-kit:inline … -->` marker comment carrying the canonical path + version, and
`inline.sh` escapes any `</script` sequence in the kit so the inlined `<script>` block
can't be closed early by the HTML parser.

## Adopted so far

- **timeline-peek** — first adopter (this PR). Read-side: owner mints a feed share link
  with the receipt + revoke; recipient view shows the banner, with the honest revoked/gone
  state when the feed rejects the token.
- **calendar-share**, **otterpilot** — to follow (#14, #17), built against this kit so the
  suite is consistent by construction.
