# otterpilot

Piggybacks a logged-in Otter.ai session to pull transcripts + screenshare frames and serve a
live "what were we talking about?" recap. Otter has **no public API** on Pro/lower tiers, so
everything reuses the Chrome cookie you're already logged in with (`browser_cookie3`) against
Otter's internal `https://otter.ai/forward/api/v1/` endpoints. Google-SSO account → password
login is dead; cookie reuse is the only path. Stay logged into otter.ai in Chrome.

Sits alongside `vexa-near-rig` (the bot-joins-the-meeting + NEAR-TEE transcription rig) as
the API-less, read-only complement: where Vexa rebuilds capture from open parts, this leverages
the high-quality transcript Otter already produces.

## Provenance and role

Built June 2026 right after IC3 camp and rescued into this monorepo 2026-07-15 from the
(remote-less) `ic3camp-teexai` tree; until then it ran only as the prebuilt image
`ghcr.io/amiller/teexai-otter` at `/otter/` on the hermes-staging pod, demoed daily.
It pairs with the interleave "brainrot box" as a combined unit — both watch the room's live
speech and drive confidential inference (NEAR / Gemini vision here; NEAR + Chutes there).
The conversation graph, decisions rail, and replay harness below are the working reference for
what conclave and shaperotatorOS should absorb. This app takes the **otterpilot** name: the
existing `../otterpilot` deno app forked from an early cut of this same `otter_web` code and
never grew these features — but it has the right credential architecture (scoped revocable
token to the oauth3 node instead of a raw cookie). The two merge into one app; see
`docs/otterpilot-merge-spec.md`.

Excluded from the rescue (still in the private tree only): meeting data under `eval/` and
`docs/tina-*`/`docs/kelsen-*`, matrix crypto stores, `bot_creds.json`, `.env.local`, and all
runtime state. All credentials are env-sourced; see `docs/google-setup.md` and `deploy_cvm.sh`
for which vars.

## Files

- **`otter_sync.py`** — archive puller. Transcripts (owned + shared, via `bulk_export` → diarized
  txt) plus screenshare frames (`get_speech` `images[]`). Incremental/resumable via
  `otter_state.json`; paced + backoff. Flags: `--no-frames`, `--audio`, `--max N`, `--force`.
- **`otter_live.py`** — terminal live tail of the in-progress meeting (`live_status=='live'`).
- **`otter_capture.py`** — Playwright HAR instrumentation (cookie-injected headless) to study
  the real web-app calls.
- **`otter_web/{server.py,index.html}`** — `localhost:8137` web app: live transcript + recap
  button + slide panel + **conversation graph** (Feed/Graph tabs). Recap/vision via NEAR private
  inference (DeepSeek text, Gemini vision); `/frame` proxies cookie-auth PNGs.

### Conversation graph (decoder + topic graph + decision lens)

A server-side **decoder** batches new transcript segments (≥4) into one NEAR call that types each
into a node (`topic|question|point|decision|divergence|action_item|aside`) with a topic label, then
groups them into clusters. The same nodes power three views, no separate pipelines: the **topic
graph** (cytoscape, click a cluster to recap just that thread — "what is this cluster? / go back a
topic"), the **decisions rail** (filtered `decision`/`action_item` nodes), and the existing recap.
State is per-meeting in `server.STATE[otid]`. `GET /graph` → `{topics, nodes, decisions}`. Design
notes in `docs/decoder-graph-spec.md`; brainstorm/triage in `docs/conversation-tooling-brainstorm.md`.

**`otter_web/replay.py`** mocks Otter from a captured diarized transcript and drives the live decode
path in batches — no live meeting needed. Offline by default (deterministic stub decoder + asserts),
or `--near` to exercise the real decoder:

```
python3 otter_web/replay.py path/to/transcript.txt --max 12 --batch 6        # offline
python3 otter_web/replay.py path/to/transcript.txt --max 12 --batch 6 --near # real NEAR
```

## Endpoints (verified live)

- `GET user` → `userid`
- `GET speeches?userid&page_size&source=owned|shared` → list (`page_size=1000` is slow/throttle-prone)
- `POST bulk_export` (`x-csrftoken`, `{formats:txt, speech_otid_list:[otid]}`) → diarized txt; works owned **and** shared
- `GET speech?userid&otid` → detail incl `transcripts[]` + `images[]`
- Frames/audio live on `api.aisense.com` and need `sessionid`+`csrftoken` sent **explicitly** as
  cookies (cross-domain; the otter.ai jar won't send them).

## Gotchas

- Live diarization is weak (speaker labels are `None`/cluster ids); clean names settle
  post-meeting via `bulk_export`.
- Otter auto-screenshot is flaky (`CANNOTDETECTSHARE`); manual capture (`source:screenshot`)
  works, `auto_screenshot` often doesn't fire.
- Vision: `Qwen3-VL-30B` too slow (>60s) → use `gemini-2.5-flash`. Rate limits bite on bursts.

## Setup

```
pip install browser_cookie3 requests playwright   # playwright only for otter_capture
```

NEAR inference key for the web app is read from a local `.env.local` (not committed).

> `otter_sync.py` writes into `../references/otter/` relative to its own location. The canonical
> running instance lives in the `teleport/planning/scripts/` knowledge base; this copy is the
> versioned, shareable home for the code.
