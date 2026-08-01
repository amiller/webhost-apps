# Tier 1 — backend flow transcript on DEPLOYED staging

Endpoint base: `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug`  (deployed build pinned below)

### pin build
$ https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/health
{"ok":true,"build":"change-detect-1","authority":"did:key:z6MkkdvtQgbX6Y5sk1GBZtpGjE85i7SmifF7mQrHrRp7Pfc7"}

### /config (OCR/VLM absent → not configured)
$ https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/config
{"build":"change-detect-1","ocr":{"configured":false,"cmd":null},"vlm":{"configured":false,"url":null}}

### 1. mint consent grant
grant (UCAN, 641 chars) minted; bearer used below.

### 2. POST /sink/frame with x-scene (scene classifier path)
$ -XPOST https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/sink/frame -H authorization: Bearer eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsInVjdiI6IjAuMS1vYXV0aDMifQ.eyJpc3MiOiJkaWQ6a2V5Ono2TWtrZHZ0UWdiWDZZNXNrMUdCWnRwR2pFODVpN1NtaWZGN21RckhyUnA3UGZjNyIsImF1ZCI6ImRpZDprZXk6ejZNa2ZoekpreURkRlhvUTVhOU1MVHphUlgzN3NoR3VMMkRDNEEzMnd2WHJDVHFhIiwiYXR0IjpbeyJ3aXRoIjoic3RyZWFtOi8vZGlkOmtleTp6Nk1ra2R2dFFnYlg2WTVzazFHQlp0cEdqRTg1aTdTbWlmRjdtUXJIclJwN1BmYzciLCJjYW4iOiJzdHJlYW0vZnJhbWVzIiwibmIiOnsibWF4UmF0ZSI6NCwidW50aWwiOjE3ODQzNzUwNjQsInNpbmsiOiJkaWQ6a2V5Ono2TWtrZHZ0UWdiWDZZNXNrMUdCWnRwR2pFODVpN1NtaWZGN21RckhyUnA3UGZjNyJ9fV0sImV4cCI6MTc4NDM3NTA2NCwicHJmIjpbXX0.7PbD72ca160x4d9UxwBExuTcXbKQg5U-dpMda96gnGYqVkHhvROk2iCuhoMIdu65vMc50cLj8PBUTAJK04nhDg -H x-seq: 1 -H x-luma: 120 -H x-scene: 1 -H content-type: image/jpeg --data-binary @/tmp/f.jpg
{"ok":true,"seq":1,"bytes":2004,"scene":true,"wantKeyframe":null}

### 3. POST /sink/heartbeat (still → skip image POST)
$ -XPOST https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/sink/heartbeat -H authorization: Bearer eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsInVjdiI6IjAuMS1vYXV0aDMifQ.eyJpc3MiOiJkaWQ6a2V5Ono2TWtrZHZ0UWdiWDZZNXNrMUdCWnRwR2pFODVpN1NtaWZGN21RckhyUnA3UGZjNyIsImF1ZCI6ImRpZDprZXk6ejZNa2ZoekpreURkRlhvUTVhOU1MVHphUlgzN3NoR3VMMkRDNEEzMnd2WHJDVHFhIiwiYXR0IjpbeyJ3aXRoIjoic3RyZWFtOi8vZGlkOmtleTp6Nk1ra2R2dFFnYlg2WTVzazFHQlp0cEdqRTg1aTdTbWlmRjdtUXJIclJwN1BmYzciLCJjYW4iOiJzdHJlYW0vZnJhbWVzIiwibmIiOnsibWF4UmF0ZSI6NCwidW50aWwiOjE3ODQzNzUwNjQsInNpbmsiOiJkaWQ6a2V5Ono2TWtrZHZ0UWdiWDZZNXNrMUdCWnRwR2pFODVpN1NtaWZGN21RckhyUnA3UGZjNyJ9fV0sImV4cCI6MTc4NDM3NTA2NCwicHJmIjpbXX0.7PbD72ca160x4d9UxwBExuTcXbKQg5U-dpMda96gnGYqVkHhvROk2iCuhoMIdu65vMc50cLj8PBUTAJK04nhDg -H x-seq: 2
{"ok":true,"still":true,"wantKeyframe":null}

### 4. POST /sink/keyframe (no hooks → explicit not-configured)
$ -XPOST https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/sink/keyframe -H authorization: Bearer eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsInVjdiI6IjAuMS1vYXV0aDMifQ.eyJpc3MiOiJkaWQ6a2V5Ono2TWtrZHZ0UWdiWDZZNXNrMUdCWnRwR2pFODVpN1NtaWZGN21RckhyUnA3UGZjNyIsImF1ZCI6ImRpZDprZXk6ejZNa2ZoekpreURkRlhvUTVhOU1MVHphUlgzN3NoR3VMMkRDNEEzMnd2WHJDVHFhIiwiYXR0IjpbeyJ3aXRoIjoic3RyZWFtOi8vZGlkOmtleTp6Nk1ra2R2dFFnYlg2WTVzazFHQlp0cEdqRTg1aTdTbWlmRjdtUXJIclJwN1BmYzciLCJjYW4iOiJzdHJlYW0vZnJhbWVzIiwibmIiOnsibWF4UmF0ZSI6NCwidW50aWwiOjE3ODQzNzUwNjQsInNpbmsiOiJkaWQ6a2V5Ono2TWtrZHZ0UWdiWDZZNXNrMUdCWnRwR2pFODVpN1NtaWZGN21RckhyUnA3UGZjNyJ9fV0sImV4cCI6MTc4NDM3NTA2NCwicHJmIjpbXX0.7PbD72ca160x4d9UxwBExuTcXbKQg5U-dpMda96gnGYqVkHhvROk2iCuhoMIdu65vMc50cLj8PBUTAJK04nhDg -H x-width: 1280 -H x-height: 800 -H x-want: vlm -H content-type: image/jpeg --data-binary @/tmp/f.jpg
{"ok":true,"bytes":2004,"width":1280,"height":800,"ocr":{"ok":false,"error":"OCR_CMD not configured"},"vlm":{"ok":false,"error":"VLM_URL not configured"},"configured":{"ocr":false,"vlm":false}}

### 5. server-side pending keyframe request, then next frame carries wantKeyframe
$ -XPOST https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/sink/want-keyframe -H content-type: application/json -d {"width":1280}
{"ok":true,"wantKeyframe":1280}

$ -XPOST https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/sink/frame -H authorization: Bearer eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsInVjdiI6IjAuMS1vYXV0aDMifQ.eyJpc3MiOiJkaWQ6a2V5Ono2TWtrZHZ0UWdiWDZZNXNrMUdCWnRwR2pFODVpN1NtaWZGN21RckhyUnA3UGZjNyIsImF1ZCI6ImRpZDprZXk6ejZNa2ZoekpreURkRlhvUTVhOU1MVHphUlgzN3NoR3VMMkRDNEEzMnd2WHJDVHFhIiwiYXR0IjpbeyJ3aXRoIjoic3RyZWFtOi8vZGlkOmtleTp6Nk1ra2R2dFFnYlg2WTVzazFHQlp0cEdqRTg1aTdTbWlmRjdtUXJIclJwN1BmYzciLCJjYW4iOiJzdHJlYW0vZnJhbWVzIiwibmIiOnsibWF4UmF0ZSI6NCwidW50aWwiOjE3ODQzNzUwNjQsInNpbmsiOiJkaWQ6a2V5Ono2TWtrZHZ0UWdiWDZZNXNrMUdCWnRwR2pFODVpN1NtaWZGN21RckhyUnA3UGZjNyJ9fV0sImV4cCI6MTc4NDM3NTA2NCwicHJmIjpbXX0.7PbD72ca160x4d9UxwBExuTcXbKQg5U-dpMda96gnGYqVkHhvROk2iCuhoMIdu65vMc50cLj8PBUTAJK04nhDg -H x-seq: 3 -H content-type: image/jpeg --data-binary @/tmp/f.jpg
{"ok":true,"seq":3,"bytes":2004,"scene":false,"wantKeyframe":1280}

### 6. counters (/sink/frames)
$ https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug/sink/frames
{"accepted":2,"rejected":0,"still":1,"scene":1,"modelCalls":0,"keyframe":{"bytes":2004,"width":1280,"height":800,"ts":1784373265899},"configured":{"ocr":false,"vlm":false},"last":[{"seq":3,"bytes":2004,"luma":0,"scene":false,"ts":1784373266712},{"seq":1,"bytes":2004,"luma":120,"scene":true,"ts":1784373265085}]}


---

## Re-verification 2026-08-01 (rework pass on PR #100)

The original transcript above was against a `change-detect-1` deploy that is **no longer present**
on staging (the project had been removed). Re-deployed the PR branch and re-ran the backend flow
against the live instance; pin + transcript:

```
GET /screenshare-debug/health  -> {"ok":true,"build":"change-detect-1","authority":"did:key:z6Mkv…"}
GET /screenshare-debug/config  -> {"build":"change-detect-1","ocr":{"configured":false},"vlm":{"configured":false}}
POST /consent/grant            -> grant issued (EdDSA UCAN, maxRate 4, expiresInSec 300)
POST /sink/heartbeat           -> {"ok":true,"still":true,"wantKeyframe":null}
POST /sink/want-keyframe {width:1280} -> {"ok":true,"wantKeyframe":1280}
GET  /sink/frames             -> {"accepted":1346,"rejected":0,"still":1865,"scene":58,"modelCalls":0,
                                  "keyframe":{"bytes":11907,"width":1280,"height":800,…},
                                  "configured":{"ocr":false,"vlm":false},"last":[…per-frame seq/bytes/luma…]}
```

`modelCalls:0` confirms no OCR/VLM call fires when unconfigured (by design). OCR/VLM report
`"not configured"`, never silent.

### Defect found & fixed while un-sticking this PR
`screenshare-debug/deploy.sh` shipped a tarball of `server.ts project.json public` but **omitted
`ucan.ts`**, which `server.ts` imports (`import {…} from "./ucan.ts"`). The shared deno runtime
router does `import("…/files/server.ts")` at boot; the missing `./ucan.ts` made that import throw, so
the router skipped `screenshare-debug` and the public route 404'd (body = the router's other-project
list). Fix: `tar … server.ts ucan.ts project.json public`. Verified: with `ucan.ts` included the app
serves HTTP 200, `/health` reports `build change-detect-1`. (Diagnosis confirmed by the router picking
up another project deployed the same day but not this one.)
