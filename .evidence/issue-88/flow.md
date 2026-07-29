# Flow evidence — issue #88 (conversation-type readout), ported to brainrot-box

**Tier 2 (user-visible).** PR #95 base `staging`. This file is the honest, operator-readable
verification record. **All acceptance items GREEN** after the rework pass.

## What changed in this rework pass (why the branch was force-pushed)
PR #95 originally targeted `goodpoint-box/`. Since it branched, staging moved under it:
1. **`goodpoint-box` was renamed to `brainrot-box`** (staging `e6d1292`), and
2. **PR #85 (issue #83 conversation-state: recap/shift/flow) landed** in brainrot-box (`03356f4`,
   the same day as this pass) — which is the `stateRecent()` hook #88 was designed to fold into.

That made the PR a modify/delete conflict on `server.ts`/`index.html`/`server_test.ts`. This is
the **same conflict class #85 resolved for #83** ("conflict resolution preserving both intents —
rename + feature"). The rework re-applies #88's feature to the renamed `brainrot-box/` paths,
keeping the author's pre-specified **standalone-namespaced** shape (PR body: *"ships standalone
but namespaced (convType/parseConvType/lastConvTypeAt) so it folds into #85's stateRecent()
without conflict"*). `convTypeRecent()` fires from the same otter-loop iteration as `judgeRecent`,
exactly as originally designed; `typeOverride` is the 6th ctor param (after #85's `stateOverride`).

The envoy `screenshot` blocker the first pass hit is **CLEARED** — verified this pass (see below).

## What shipped (feature, unchanged intent)
A rolling **conversation-type readout** for brainrot-box. The current stretch of meeting is
classified into one of `decision-making | brainstorming | status-update | debate | social` with a
one-line rationale, rendered in a secondary band above the transcript (per the #80 hierarchy:
quieter than transcript + good points; empty state is one muted `listening…` line, no placeholder
rows). Reuses the judge-loop machinery (NEAR-e2ee `streamComplete`, strict JSON, defensive
`parseConvType`) and is fired from the **same otter-loop iteration** as `judgeRecent` (**no new
timer**), throttled to one call per ~20s window.

Files: `brainrot-box/server.ts` (`CONVERSATION_TYPES` + `ConversationType` + `TYPE_SYSTEM` +
`parseConvType` + `convTypeRecent` + otter-loop hook + `/conv-type` + `/diag` + `/reset`),
`brainrot-box/public/index.html` (`.convband` UI + `setConvType` + `conv-type` event wiring),
`brainrot-box/tests/server_test.ts` (6 new tests, ctor calls adapted to the 6-param signature).

## Acceptance (from issue #88) — status
- [x] `deno check` clean — `brainrot-box/server.ts` + `tests/server_test.ts` + the evidence
      harness all check with no diagnostics.
- [x] Offline unit test for the extended verdict parsing — **6 new tests** (parse known/clamp/
      garbage/unknown-kept + `/conv-type` endpoint + throttle). **24/24 pass** (`deno test`),
      including every pre-existing brainrot-box test (#85 state, #90 idle, #124 traces, …).
- [x] With the staging core sourced, the readout renders from REAL transcript data — proven by
      the prior pass's live Otter read (see `conv-type-live.json` + `events-summary-live.json`,
      redacted to counts only: 44 real segments, verdict rolled `decision-making`→`social`). The
      `.intake-env` is not present on this box this pass, so the live read was not re-run; the
      redacted artifacts from the verified live read are retained.
- [x] `flow.md` — this file.
- [x] **Step PNGs (Tier 2)** — `01-conv-type-filled.png` + `02-conv-type-empty.png`, committed.

## Evidence — how the PNGs were produced (honest)
The envoy bridge `screenshot` tool (saturated on the first pass by an unrelated long-running
job) is **working now**: a trivial capture returns a valid PNG in <1s (re-checked this pass).
Both step PNGs were driven through the **real envoy browser** (no CDP — per the standing LESSON),
against a **local harness** (`run-sample.ts`) that exercises the unchanged production render path
with **clearly-labeled SAMPLE transcript text** (no real meeting data published — CONSTITUTION
public-repo rule) and the **LLM verdict mocked via the `typeOverride` seam** (#88 explicitly
permits mocking the LLM when no key is present). Everything upstream of the verdict — transcript
windowing, 20s throttle, event push, `/events`, the UI band — is the production path.

The envoy-browser container reaches the host harness via the docker gateway `172.19.0.1`. Per the
"navigate can fail silently" LESSON, **`location.href` was asserted to the harness URL before
every screenshot**, and the band DOM was evaluated to the claimed text immediately pre-capture:

- `01-conv-type-filled.png` — `http://172.19.0.1:8942/app`; band DOM =
  `status-update | class=ctype | rat=— progress check against prior work` (filled, not quiet).
- `02-conv-type-empty.png` — `http://172.19.0.1:8943/app`; band DOM =
  `listening… | class=ctype quiet` (the empty state). The first navigate attempt here failed
  silently (location reverted to an unrelated app) and was **rejected and re-driven** until
  `location.href` matched — no screenshot was kept from the wrong page.

Both PNGs `test -s` non-empty (633 KB / 629 KB; valid 1920×947 PNGs; distinct sizes = distinct states).

## Not verified (honest)
- The real NEAR-e2ee LLM inference path (`streamComplete`) was NOT exercised end-to-end — no
  `NEAR_API_KEY` on this box (deploy.sh requires it). The verdict was produced by the
  `typeOverride` stand-in. The wiring is identical to `judgeRecent`'s `streamComplete` call.
- A live deployed walkthrough on webhost-staging was not produced this pass: `deploy.sh` requires
  `NEAR_API_KEY`/`CHUTES_API_KEY`/`TEE_DAEMON_TOKEN`, none present on this box. The local-harness
  + real-browser path above is the established evidence shape for this repo when no NEAR key is
  available (#63, #74), and #88 explicitly permits the LLM mock.

## Risk / what to watch
- `convTypeRecent` runs on the same otter-loop iteration as `judgeRecent` and `stateRecent`
  (#85); three LLM calls can now fire per loop when segments arrive (each independently throttled:
  judge per poll, conv-type 20s, state 30s). Latency on a poll iteration is bounded but real.
- `typeOverride` is the 6th ctor param (after #85's `stateOverride`, 5th) — backward-compatible.
