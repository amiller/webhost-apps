# screenshare-debug

**Live:** https://pod.dstack.soc1024.com/screenshare-debug/ · staging: `$WEBHOST_STAGING/screenshare-debug/`

An opt-in **debug-trace recorder** (#70): a user hitting a bug presses **Start**, shares **one
window** (the picker scopes the capture), reproduces it, presses **Stop**. Better than
screenshots-by-hand, lighter than video — for the devs who have to replay it.

**Review-before-send is the opt-in UX.** Recording never leaves the browser: frames land in the
page's own memory, the user reviews the filmstrip, deletes frames, **blacks out regions —
applied before the JPEG is encoded, so redacted pixels never exist as an image** — writes a
freeform *what were you doing?* note, and only then presses **Upload**. The sink receives one
bounded session. Near-identical frames are change-dropped while recording (smaller traces,
less incidental exposure).

- **Session sink** (`server.ts`, deno, zero deps) — frames + metadata (`ts`/`bytes`/`luma`)
  grouped under a session id with the note, under `.data/sessions/<sid>/`. Traces are
  **ephemeral**: unkept sessions expire after 1h; `POST /sink/session/<sid>/keep` is the only
  way one outlives that. Dev side: `GET /sink/sessions` → filmstrip (`GET
  /sink/frame/<sid>/<seq>.jpg`) → per-frame metadata.
- **Privacy dials** — window-scoped capture, width/JPEG-quality floors, change-drop floor,
  blackout rects. No OCR, no model pass (out of scope for the spine; see the issue).
- **No authorization machinery** (non-goal, deliberately): no identity, no sign-in, no grants,
  no tokens. The browser originating the upload is the control. The earlier consent/UCAN build
  is excised — see [NOTES-consent-demo.md](NOTES-consent-demo.md).
- **`?synthetic=1`** — animated canvas frame source so tests don't depend on capture.

## e2e (docker compose)

```bash
docker compose up --build --exit-code-from e2e
```

Brings up the deno sink plus a headful Chromium under Xvfb that captures its own virtual
display (`--auto-select-desktop-capture-source="Entire screen"`
`--use-fake-ui-for-media-stream`), drives record → review → redact → upload, and exits 0 only
if: the sink lists **nothing** for the session before Upload; kept frames land under the session
id after; the deleted frame is absent; and a decoded JPEG is uniformly black inside the blackout
rect. Screenshots land in `e2e/out/`.

## Deploy

```bash
bash deploy.sh            # pod
CVM=$TEE_DAEMON_URL bash deploy.sh   # staging (source ~/.tee-daemon-staging.env)
```
