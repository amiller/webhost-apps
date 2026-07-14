# screenshare-debug — capture screen traces into a pod, under revocable consent

**Live demo:** https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/

A small, copyable template for one technique: turning a live screen into a **verifiable
trace of JPEG frames** delivered into a pod you control, where the stream runs under a
**scoped, revocable consent grant** instead of a raw POST. Debug evidence, session
recordings, agent-run filmstrips — anything where "what exactly was on screen, when,
and did the pod really receive it" matters.

## The technique — three steps

1. **Capture (browser).** `getDisplayMedia` → downsample to a target width → per-frame
   luma → JPEG. All client-side; interval / width / quality are live controls. See
   `capture()` in `public/index.html`.
2. **Consent.** Clicking Start mints a scoped, revocable grant bound to your oauth3
   identity (`{sub, sink, rate, scope, iat, exp, jti}`, app-signed, stateless to verify).
   Every frame POST carries it as a bearer. No credential ever leaves the user.
3. **Sink (pod).** A small deno endpoint verifies the grant on **every** frame, stores the
   trace, and echoes the received frames back — so delivery is provable, not assumed.
   Revoke adds the grant's `jti` to a persisted revocation set; the very next frame POST
   **401s, visibly, in the page's console**.

This inverts the usual oauth3 flow: instead of delegating *read* access to a session you
hold, you delegate a live **outbound stream** (your screen) — scoped, revocable, attested.

## Use it as a template

The whole app is three files. Copy the directory, point `deploy.sh` at your tee-daemon:

| file | what it is |
|---|---|
| `server.ts` | the sink: grant mint / verify / revoke + trace store (251 lines, deno, zero deps) |
| `public/index.html` | the capture client + live console (preview, echo strip, per-frame table) |
| `deploy.sh` | tarball → `POST /_api/projects` on a tee-daemon (38 lines) |

```bash
bash deploy.sh    # default echo-sink build — no secrets needed
```

Optional env: `OAUTH3_NODE` (identity node, defaults to the pod), `AISHLEY_URL` /
`AISHLEY_VERIFY` (enable the encrypted-to-enclave second sink; shown, not exercised, by
the default build).

Desktop-only: `getDisplayMedia` isn't implemented on mobile browsers.

## Honest auth note

oauth3 provides the **sign-in identity** (`window.oauth3.signIn`) and is the trust root the
grant binds to — but the grant itself is **signed by this app** (HMAC, key generated into the
app's `dataDir` on first run). That's because the oauth3 node can't yet verify its own scoped
tokens on behalf of a third-party sink — there is no token-introspection endpoint. Tracked in
[oauth3-server#121](https://github.com/teleport-computer/oauth3-server/issues/121); when it
lands, the sink drops all of its own token code and this becomes a plain oauth3 app.
(An offline-verification spike — RFC 0011 did:key UCANs — exists on the `screenshare-ucan`
branch and stays parked for the same reason: no delegation innovation inside apps.)

## Acceptance (issue #51)

Open the app → Start → pick a window: within seconds the console shows frames streaming
(live preview, the echo strip filling, the per-frame table with bytes / luma / latency and
`delivered = yes`). Hit Revoke: the stream visibly stops and the next frame POST 401s in
the console.

Design: pod design system · constructivist overprint · watermelon-classic inks (teal
`#00838a` / fluoro pink `#ff48b0`) · light default.
