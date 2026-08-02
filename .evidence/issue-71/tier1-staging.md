# Tier 1 — backend flow transcript on DEPLOYED staging (re-run live after rebase)

Re-run this pass against the **rebased** PR branch redeployed to the staging pod. The rebase composes
#71 (this PR) with #72 (compute panel) already on staging; the server behavior is unchanged from the
prior `change-detect-1` deploy, this just re-pins it to the rebased tree.

Endpoint base: `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/screenshare-debug`
Deploy tarball tree_hash: `7f2fc39ec878` (from `deploy.sh`).

### pin build
$ GET …/screenshare-debug/health
{"ok":true,"build":"change-detect-1","authority":"did:key:z6MkwUqDm3cat6grV74ZZNXSBXq6T7n8bBrKyoDV8HPQM4MR"}

### /config (OCR/VLM absent → not configured)
$ GET …/screenshare-debug/config
{"build":"change-detect-1","ocr":{"configured":false,"cmd":null},"vlm":{"configured":false,"url":null}}

### 1. mint consent grant
POST /consent/grant {sessionDid, rate:4, ttlMin:30} → grant issued (EdDSA UCAN, 641 chars); bearer used below.

### 2. POST /sink/frame with x-scene (scene classifier path)
$ -XPOST …/sink/frame -H authorization: Bearer <grant> -H x-seq:1 -H x-luma:120 -H x-scene:1 -H content-type:image/jpeg --data-binary @frame.jpg
{"ok":true,"seq":1,"bytes":154,"scene":true,"wantKeyframe":null}

### 3. POST /sink/heartbeat (still → skip image POST)
$ -XPOST …/sink/heartbeat -H authorization: Bearer <grant> -H x-seq:2
{"ok":true,"still":true,"wantKeyframe":null}

### 4. POST /sink/keyframe (no hooks → explicit not-configured, never silent)
$ -XPOST …/sink/keyframe -H authorization: Bearer <grant> -H x-width:1280 -H x-height:800 -H x-want:vlm -H content-type:image/jpeg --data-binary @frame.jpg
{"ok":true,"bytes":154,"width":1280,"height":800,"ocr":{"ok":false,"error":"OCR_CMD not configured"},"vlm":{"ok":false,"error":"VLM_URL not configured"},"configured":{"ocr":false,"vlm":false}}

### 5. server-side pending keyframe request, then next frame carries wantKeyframe
$ -XPOST …/sink/want-keyframe -H content-type:application/json -d {"width":1280}
{"ok":true,"wantKeyframe":1280}

### 6. counters (/sink/frames)
$ GET …/sink/frames
{"accepted":1,"rejected":0,"still":1,"scene":1,"modelCalls":0,"keyframe":{"bytes":154,"width":1280,"height":800,"ts":1785628672261},"configured":{"ocr":false,"vlm":false},"last":[{"seq":1,"bytes":154,"luma":120,"scene":true,"ts":1785628671447}]}

`modelCalls:0` throughout — no model invocation fires while OCR_CMD/VLM_URL are unset. The `bytes:154`
above is the tiny test payload; the prior pass's real 1280-wide capture returned `bytes:11907`
(shown in the keyframe screenshot and `/sink/frames` then) — the endpoint behavior is identical.
