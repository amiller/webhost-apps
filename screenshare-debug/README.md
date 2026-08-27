# screenshare-debug

**Live demo:** https://pod.dstack.soc1024.com/screenshare-debug/

The **screen-stream analogue of twitter-debug**: a debug surface for the browser→pod frame
path. The browser turns a live screen into a stream of JPEG frames and POSTs each one to
this pod's sink; the sink stores the trace and echoes it back, so you compare what you
**sent** against what the pod **received**, frame by frame — bytes, luma, latency, HTTP
outcome.

- **Capture client** — ported from `tee-daemon/examples/screenshare-frames`:
  `getDisplayMedia` → downsample → per-frame luma → JPEG. Interval / width / JPEG-quality
  are live controls. Desktop-only (`getDisplayMedia` isn't implemented on mobile browsers).
- **Sink** — a small pod endpoint (`server.ts`, under 100 lines, deno, zero deps) that
  stores the last 60 frames + metadata and serves them back for the echo strip and the
  per-frame table.
- **oauth3 = identity only.** The streamer signs in via `window.oauth3.signIn` and frames
  are tagged with the subject (`x-subject`). No plugin, no grants; oauth3 is never in the
  frame data path. Without the extension the trace is tagged with a clearly-labeled anon id.

The earlier consent-grant/capability build of this app (HMAC grants, revoke→401, share-kit
receipt, aishley second sink, the did:key UCAN spike) is excised — see
[NOTES-consent-demo.md](NOTES-consent-demo.md) for that material, kept for a separate demo.

## Deploy

```bash
bash deploy.sh   # no secrets needed
```

Design: pod design system · constructivist overprint · watermelon-classic inks (teal
`#00838a` / fluoro pink `#ff48b0`) · light default.
