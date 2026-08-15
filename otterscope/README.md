# otterscope

Otter.ai transcript viewer over OAuth3 — reads your Otter conversations through the oauth3
`otter` plugin (a scoped token, never a raw cookie) and renders them a page at a time.

Deno app, deployed as a tee-daemon project on the pod. Live: https://pod.dstack.soc1024.com/otterscope/

## Connect paths (RFC 0008 — extension-optional)
otterscope connects via the **oauth3-sdk `connect()` handshake**, never `window.oauth3` directly.
The SDK decides: with the browser extension present the wallet carries the whole flow
(provider-preferred — unchanged behavior); without it (phone, clean profile, same-pod) the page
renders the SDK's `approveUrl` as a clickable link — approve in your **signed-in pod room** and
the page picks the scoped token up on its own. The token persists in localStorage until you log
out. Reading a jar that isn't synced yet returns a legible 409 ("add it from a device with the
extension") — never a dead end.

## Env
`OAUTH3_NODE` (the pod's oauth3 instance). No secrets.

## Deploy
Source-tarball to the pod tee-daemon (`POST /_api/projects`, Bearer `TEE_DAEMON_TOKEN`),
`runtime: deno`, `entry: server.ts`.
