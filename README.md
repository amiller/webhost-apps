# webhost-apps

My personal apps that run on a **dstack-webhost** (`tee-daemon`) CVM. This is a
private monorepo — *not* the host. The host (`amiller/dstack-webhost`) is a tool
others pull; it stays clean. These are the apps I deploy onto an instance of it.

## How it works

Each app is one self-contained subdirectory: an entry file the runtime
autodetects (`server.ts` deno · `app.py` python · `index.js` node · `Dockerfile`
· `.` static) plus an optional `project.json` (`{runtime, entry, mode, env}`).

The daemon deploys a *directory*, not a repo — so a subfolder here deploys fine
via tarball, no per-app GitHub repo needed:

```bash
tar czf /tmp/app.tgz -C <app> <entry> project.json
curl -X POST $CVM/_api/projects -H "Authorization: Bearer $TEE_DAEMON_TOKEN" \
  -F 'manifest={"name":"<app>","runtime":"deno"};type=application/json' \
  -F files=@/tmp/app.tgz
```

Most apps just have their own `deploy.sh` that does this (see `router-dashboard/`).

## When an app graduates to its own repo

Only when it earns it: a real collaborator, or an independent release/deploy
lifecycle. Then it deploys from source instead — `{"source":"github.com/me/x"}` —
with no change to the daemon or the other apps. Until then it lives here.

## What's deployed where

Source of truth for *running* state is the CVM itself (`GET /_api/projects`).
`REGISTRY.md` is just the local map of app → intended instance.
