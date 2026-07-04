# otterscope

Otter.ai transcript viewer over OAuth3 — reads your Otter conversations through the oauth3
`otter` plugin (a scoped token, never a raw cookie) and renders them a page at a time.

Deno app, deployed as a tee-daemon project on the pod. Live: https://pod.dstack.soc1024.com/otterscope/

## ⚠️ Currently extension-dependent
otterscope connects via `window.oauth3.connect` — the API injected by the **browser extension**.
That means it can't be used without the extension (e.g. on mobile), even though the underlying
delegation (login + approve use of already-synced cookies) doesn't require it. See the SDK
"extension-optional" work (oauth3-server): the connect/approve flow should work through the pod's
own web login (google/github/passkey/did:key) like feedling does, falling back to `window.oauth3`
only when the extension is present. Until then, otterscope needs the extension.

## Env
`OAUTH3_NODE` (the pod's oauth3 instance). No secrets.

## Deploy
Source-tarball to the pod tee-daemon (`POST /_api/projects`, Bearer `TEE_DAEMON_TOKEN`),
`runtime: deno`, `entry: server.ts`.
