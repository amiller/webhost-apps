# timeline-peek

A minimal OAuth3 relying-party demo. It asks the browser extension for a **scoped `twitter`
token** via `window.oauth3.connect()`, then reads the timeline from the pod's
`/oauth3/api/twitter/feed` — **the app never touches cookies**; the TEE pod does the
authenticated read and hands back only the feed.

Single self-contained `index.html` (no build, no backend). Deploy as a `static` project with
`entry: index.html`.

**Capability sharing** uses [`share-kit`](../share-kit/) — the suite's one shared
share UI. The owner gets a `Share my feed →` action + a capability receipt (link,
plain-English scope sentence, Revoke, status pill); the shared view shows a recipient
banner with an honest revoked/gone end-state when the token is rejected.
`share-kit.js` is **inlined** into this `index.html` (single-file static app) inside the
`<!--share-kit:inline-->` block — refresh it with `../share-kit/inline.sh timeline-peek`.

> Source rescued 2026-07-02 from the running pod (`pod.dstack.soc1024.com/timeline-peek`) —
> it had been deployed (Jun 30) without a committed source. See ../POD-APPS-AUDIT.md.
