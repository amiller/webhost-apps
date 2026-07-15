# live loop on cue

The live copilot loop (decoder → graph, periodic consolidate, on-demand recap) is
expressed as a cue config. cue is TypeScript, so the config typechecks against
`@cue/core` — that's our spec/guarantee.

**Canonical config:** `~/projects/cue/examples/otter-live/server.config.ts` (typechecks clean
via `tsc -p tsconfig.json`; runs via `pnpm run server -- examples/otter-live/server.config.ts`).

Three cadences over the transcript stream, no keyword cues:

| program | cue | tool | role |
|---|---|---|---|
| decoder | `WordCountCue(55)` | `graph.add_nodes` | code transcript into the topic graph (nodes carry a `notable` flag = "good point") |
| consolidator | `IntervalCue(180)` | `graph.consolidate` | rebalance the topic taxonomy (the axial pass) |
| recap | `ManualCue(false)` | `recap.now` | "what were we just talking about?" on demand |

NEAR (DeepSeek) is OpenAI-shaped, so it reuses cue's `CerebrasLLMProvider` repointed at
`cloud-api.near.ai`. The bounded insights *report* stays in `../insights.py` (→ a smithers
workflow when it goes premium/TEE). See memory `open-core-tee-workflows`.

**Still TODO — the Otter→cue feeder** (~30 lines, not yet written): reuse
`otter_session.open_session()`, poll the live speech, and POST each new segment as
`{ type: "transcript.segment", payload: { text, speaker: "S<label>", isFinal: true }, timestamp }`
to `http://localhost:8139/sessions/<otid>/observations`. Vexa feeds the identical shape, so
the config is source-agnostic.
