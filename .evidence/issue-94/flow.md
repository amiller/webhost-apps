# #94 — brainrot-box privacy cleave (REGENERATED on rebase 2026-08-15)

Supersedes the pre-rebase flow.md (goodpoint-box paths, 12 tests). The branch was rebased from
`cee4c20` onto `97ef6ed` (staging, 24 commits later: goodpoint-box → brainrot-box; +distill #93,
+decoder graph, +state #83, +convtype #88, +self-eval/critic #92, +traces #124, +snapshots #125).
The old evidence is invalid against the merged tree; this file regenerates it per the rework spec.

## What the merged change does
Splits inference lanes by what they may hear, per the operator's boundary ruling in issue #94
("models that HEAR THE ROOM (judge, any transcript→brief distillation incl. #93's) stay on e2ee
confidential inference. Models that only do AESTHETICS may run on any fast hosted model — IF the
brief they receive is sanitized"):

- **Hearing lanes — e2ee BY CONSTRUCTION (no hosted branch exists for them):** `judge`
  (`JUDGE_MODEL`), `distill` (`DISTILL_MODEL`), `decoder` (`DECODER_MODEL`), `state` +
  `convtype` (`STATE_MODEL`). Their models no longer inherit `TOOLSMITH_MODEL`/`COMPOSITOR_MODEL`
  (those may point at hosted models); the defaults preserve pre-cleave behavior exactly.
- **Paint lanes — hosted-when-configured:** `toolsmith`/`compositor` via
  `TOOLSMITH_BASE_URL`/`COMPOSITOR_BASE_URL` (+key), and the compositor-class `critic` (reads only
  composition signatures) which shares the compositor's hosted transport.
- **Sanitized brief:** banger → `sanitizeBrief(point)` (mood label, tone-from-score, STRUCTURAL
  emphasis = word-count + register, constant direction; no quote, no judge `why`). #93's distill →
  `sanitizeDistilled(j, transcript)`: emphasis ALWAYS structural; mood/tone/direction kept as the
  model's own paraphrase unless a transcript 3-gram trips `leaksVerbatim`, in which case the field
  is blanked and a `status` event names it (absent renders "—", never masked). `DISTILL_SYSTEM`'s
  output contract now demands structural emphasis + original phrasing (prompt-side + runtime guard).
- **Client unchanged:** the verbatim quote still flows only to the client (`SSE goodpoint.point`);
  the client renders `brief.mood/tone/direction` (never `emphasis` — verified in `public/index.html`),
  so sanitizing emphasis breaks nothing on the page.

## Acceptance → evidence

| Acceptance (#94) | Status | Evidence |
|---|---|---|
| Grep: no verbatim quote/transcript in toolsmith/compositor prompts; unit test asserts no 3-gram | ✅ | grep below; `#94 sanitizeBrief…` + `#94 distill output is sanitized…` |
| Client still renders verbatim quote (flash + ledger) — offline render test | ✅ | `#94 judge event keeps the verbatim quote for the client…`; client uses `point.quote` |
| Provider config: hosted TOOLSMITH endpoint → tools forge, judge still e2ee (mocked) | ✅ | `#94 with hosted TOOLSMITH configured, tools still forge…` + `…hearing lanes stay e2ee (rebase ruling)` |
| README boundary section; deno check clean; flow.md + evidence; base staging | ✅ | README "Privacy boundary (#94)"; `deno check` clean; this file; PR base `staging` |

## Test transcript (re-run on 55582bf 2026-08-15: 52 passed | 0 failed — staging suites have grown since the rebase; the 7 #94 tests all present and green)
```
deno check server.ts                        → clean
deno check tests/server_test.ts             → clean
deno test --allow-all tests/server_test.ts  → ok | 52 passed | 0 failed (3s)

#94 sanitizeBrief carries no verbatim trigram of the quote ... ok
#94 judge event keeps the verbatim quote for the client, sanitized brief for the crew ... ok
#94 with hosted paint endpoints configured, hearing lanes stay e2ee (rebase ruling) ... ok
#94 with hosted TOOLSMITH configured, tools still forge while judge stays e2ee (mocked) ... ok
#94 /diag reports per-lane routing (no secrets) ... ok
#94 distill output is sanitized before the paint crew sees it (verbatim key phrase dropped) ... ok
#94 trigram leak detector: 3 consecutive transcript words trip it, paraphrase does not ... ok
(+ all inherited #90/#83/#88/#92/#124/#125 suites green; one inherited assertion updated:
 "#92 /diag surfaces the self-eval fields" now reads the critic model/enabled from the new
 routing block instead of the removed flat e2ee block — same intent, new #94 schema.)
```

## Grep proof — verbatim reaches ONLY hearing lanes + the client
```
server.ts:1333  `Transcript:\n${recent}\n\nJSON:`                 # distill lane (e2ee)
server.ts:1450  `Transcript:\n${text}\n\nJSON:`                   # judge lane  (e2ee)
server.ts:1473  `Transcript:\n${text}\n${prior}JSON:`             # state lane  (e2ee)
server.ts:1511  `Transcript:\n${text}\n\nJSON:`                   # convtype lane (e2ee)
decoderTurn     `Open topics…\nSegments:\n${lines}…`              # decoder lane (e2ee)
server.ts:1452  const point = { quote: judge.quote, … }           # judge result → ledger + CLIENT
server.ts:541   emphasis: describePhrase(point.quote)             # STRUCTURAL read (word count)
server.ts:1564  `…Brief: ${JSON.stringify(this.brief)}…`          # toolsmith prompt — sanitized brief
server.ts:1602  `…Brief:\n${JSON.stringify(this.brief)}…`         # compositor prompt — sanitized brief
server.ts:1459  this.push({ type: "goodpoint", point, … })        # verbatim quote → CLIENT only
```
`point.quote`/`judge.quote` appear nowhere else; `point.why` never enters the brief. The brief
writers are: banger (`sanitizeBrief`), distill (`sanitizeDistilled`), self-nudge (constant mood
vocabulary + preserved structural emphasis), critic line (signature-derived) — none carry verbatim.

## Deployed-staging Tier 1 transcript (2026-08-15, this pass)
Keys located (`~/.config/private-inference.env` — both `NEAR_API_KEY` and `CHUTES_API_KEY`;
the earlier "not on this box" blocker missed `~/.config`). Deployed via `brainrot-box/deploy.sh`
to the webhost-staging CVM: **daemon deploy tree_hash `50466b3224a3`**, project name
`goodpoint-box` (staging's convention — matches `origin/staging`'s own deploy.sh) AND synced to
the canonical `brainrot-box` name so `/brainrot-box/` serves this PR's tree. Full transcript:
`.evidence/issue-94/staging-transcript.txt` — defaults all-e2ee; hosted-config variant shows
toolsmith `hosted` with all five hearing lanes e2ee; no secrets in `/diag`.
`/_api/version` pin: the app defines no such route (daemon gateway 404 for app paths — same
caveat as #124/#90/#136); the pin is **git `55582bf` + daemon tree_hash `50466b3224a3`**, and
the daemon root `/_api/version` reads `{"version":"dev","commit":"39c54cc8"}` (daemon build,
not the app).

## Live /diag routing transcript (local serve — superseded by the deployed transcript above; kept as the fallback record of the same behavior)
Defaults (no BASE_URLs — staging behavior preserved, all e2ee):
```json
[{"lane":"judge","model":"deepseek-ai/DeepSeek-V4-Flash","transport":"near-e2ee","hears_room":true},
 {"lane":"distill","model":"unsloth/Mistral-Nemo-Instruct-2407-TEE","transport":"chutes-e2ee","hears_room":true},
 {"lane":"decoder","model":"deepseek-ai/DeepSeek-V4-Flash","transport":"near-e2ee","hears_room":true},
 {"lane":"state","model":"deepseek-ai/DeepSeek-V4-Flash","transport":"near-e2ee","hears_room":true},
 {"lane":"convtype","model":"deepseek-ai/DeepSeek-V4-Flash","transport":"near-e2ee","hears_room":true},
 {"lane":"critic","model":"unsloth/Mistral-Nemo-Instruct-2407-TEE","transport":"chutes-e2ee","hears_room":false,"enabled":false},
 {"lane":"toolsmith","model":"deepseek-ai/DeepSeek-V4-Flash","transport":"near-e2ee","hears_room":false},
 {"lane":"compositor","model":"unsloth/Mistral-Nemo-Instruct-2407-TEE","transport":"chutes-e2ee","hears_room":false}]
```
With `TOOLSMITH_BASE_URL=https://fast.example/v1` + `TOOLSMITH_API_KEY=k-never` set: the toolsmith
entry flips to `{"transport":"hosted"}` and EVERY hearing lane stays e2ee; the response contains
neither `k-never` nor `fast.example` (no key/URL disclosure). Serving proof: `GET /` → 200,
`GET /app` → 200, `<title>brainrot-box</title>`.

## Conflicts resolved (rebase 97ef6ed ← f42f400)
- **Rename**: all changes moved `goodpoint-box/` → `brainrot-box/` (staging's rename); old paths
  removed. `hosted_stream.ts` carried over verbatim.
- **streamComplete signature** `model→lane`: all 8 staging call sites re-laned per the ruling
  above. Inherited tests are signature-compatible (they dispatch on `system`, not model).
- **Brief shape**: kept staging's `{mood, emphasis, tone, direction, avoid?}` (client renders
  mood/tone/direction; #92's avoid-nudge survives banger + distill rewrites) — the PR's `energy`
  concept lives on as the banger `tone` value.
- **/diag**: flat `e2ee` block → per-lane `routing` (critic model/enabled now ride its entry).
- **#93 semantic collision** (the reason the previous rework pass blocked): distill ran on
  `compositorModel` and emitted a verbatim key phrase into `brief.emphasis`. Resolved by the
  operator's standing ruling in #94's issue body: distill gets its own E2EE lane and
  `sanitizeDistilled` bounds its output (emphasis structural; paraphrase fields trigram-checked).
  #93's craft (continuous distillation, tone reading, visual plan, banger override) is preserved.

## What I could NOT verify (honest)
1. ~~Staging deploy~~ **RESOLVED 2026-08-15** — keys found in `~/.config/private-inference.env`
   (the earlier checks missed `~/.config`). Deployed; transcript above.
2. **Tier 2 signed-in banger walk**: needs a live Otter meeting to fire the judge on real speech
   (the deployed app's otter read currently returns `409 challenge_pending` — step-up owed). The
   change is server-side with no user-visible diff (client still renders `point.quote`, never reads
   `brief`), so Tier 1 is the honest tier for this PR. No image committed rather than fabricate one.

## Resolved blocker (was: need from operator)
- ~~`NEAR_API_KEY` + `CHUTES_API_KEY` on this box~~ — found at `~/.config/private-inference.env`;
  deployed and pinned (git `55582bf` + daemon tree_hash `50466b3224a3`). No operator action owed
  for Tier 1.
