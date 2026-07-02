# timeline-peek

A minimal OAuth3 relying-party demo. It asks the browser extension for a **scoped `twitter`
token** via `window.oauth3.connect()`, then reads the timeline from the pod's
`/oauth3/api/twitter/feed` — **the app never touches cookies**; the TEE pod does the
authenticated read and hands back only the feed.

Single self-contained `index.html` (no build, no backend). Deploy as a `static` project with
`entry: index.html`.

> Source rescued 2026-07-02 from the running pod (`pod.dstack.soc1024.com/timeline-peek`) —
> it had been deployed (Jun 30) without a committed source. See ../POD-APPS-AUDIT.md.
