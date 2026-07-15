# In-meeting conversation tooling — brainstorm & PRD seed

Session: 2026-06-19. Captures the brainstorm following the otter-integration demo,
triage of feature ideas, and the cross-notes correlations that shape priorities.

## Why this doc exists

The Otter session-piggyback prototype worked well in a live meeting. The
"what were we talking about?" recap (NEAR DeepSeek-V4-Flash text / Gemini-2.5-flash
when a slide is up) subjectively beats Otter's own summaries. That validated the
core loop: live transcript → NEAR inference → useful in-meeting output. This doc
plans what to build on top of that loop.

## Current state (what already exists)

- **Ingestion paths**
  - **Otter piggyback** (`otter_*.py`, `otter_web/`): reuses Chrome cookies
    (`browser_cookie3`) against Otter's internal REST API. No API key. Requires
    being logged into otter.ai in Chrome. Diarization is **lagged** — live labels
    are cluster IDs (`S0`, `S1`); human names settle only after the meeting via
    `bulk_export`.
  - **Vexa** (`../vexa-near-rig/`): a bot joins a Google Meet, captures audio in
    realtime → NEAR Whisper TEE. Works as long as someone runs the Vexa instance.
    Demoed successfully.
- **Web tool** (`otter_web/server.py` :8137, vanilla HTML/JS, 8s polling)
  - Transcript feed (left)
  - "What were we talking about?" recap button (NEAR; text or multimodal w/ slide)
  - Slide panel (right): latest screenshot + thumbnail strip, image proxy `/frame`
- **LLM**: `cloud-api.near.ai/v1/chat/completions`, two-model strategy
  (DeepSeek-V4-Flash text, Gemini-2.5-flash multimodal). `NEAR_KEY` env / `~/.env.local`.

## The big idea: one decoder, many views

Don't build the topic graph and the various "lenses" as separate features. They're
**one engine**: a *conversation decoder* that turns each transcript segment into a
typed node:

```
node = {
  id, t_start, t_end, speaker (cluster id, name if known),
  kind: topic | question | point | decision | divergence | action_item | aside,
  text, summary,
  edges: [{to: node_id, rel: reply-to | digression-from | resolves | continues}]
}
```

Then every feature is a view or query over the same node stream:

- **Topic graph / conversation map** = spatial render of nodes + edges
- **Decision extraction** = filter `kind == decision` (and `point`)
- **Agenda-coverage tracker** = diff `topic` nodes against the primed agenda
- **Talk-time balance** = group nodes by speaker cluster
- **Recap** (already exists) = temporal slice of recent nodes
- **Late-joiner recap** = recap scoped to "since they joined"
- **Missing-context injection** = node whose `text` introduces a term not seen
  before, cross-referenced against a participant's primed background

Build the decoder once on top of the NEAR call we already have; each lens becomes a
small query rather than a new pipeline.

## Feature catalog

### Phase 0 — Onboarding / linking
- **Otter linking**: local cookie-copy tool (current approach) or a browser
  extension for non-local users. Surface the diarization-lag constraint in UX.
- **Vexa path**: bot joins Google Meet → NEAR Whisper TEE. Already works.
- **Meeting context priming**: capture meeting purpose + participant backgrounds at
  link/join time. Fuels the missing-context and recap lenses. Doubles as the
  onboarding "aha" (echoes Tina/Shashank: "here are the keywords/topics I think
  matter — validate me").

### Phase 1 — In-meeting live views
- Transcript feed ✅ exists
- "What were we talking about?" recap ✅ exists
- **Topic graph / conversation map** ⭐ flagship. Transcript-only → works for both
  Otter and Vexa.
- **Agenda-coverage tracker**: "proposed 3 things, covered 2" — a view on the graph
  + primed agenda.

### Phase 2 — Continuous multi-lens processor (background passes)
- **Decision / good-point extraction** — high value, transcript-feasible.
- **Late-joiner recap → side chat** — easy win; Tina already does this manually.
- **Missing-context / pitfall injection** ("Alice won't know this term") — high wow,
  needs Phase-0 participant priming.
- **Talk-time balance** — feasible *live* via cluster IDs (no names needed for
  balance; names only to label who's quiet). More doable than first assumed.
- **Emotional state** — low feasibility from text alone; defer.
- **Hunger → food-budget trigger** — novelty/demo tier; defer.

## Triage

| Feature | Value | Feasibility | Tier |
|---|---|---|---|
| Topic graph / conversation map | high (3-way convergent) | med (transcript-only) | **Build now** |
| Decision/point extraction | high | high | **Build now** |
| Late-joiner recap → side chat | med | high | Fast follow |
| Agenda-coverage tracker | med | med (view on graph) | Fast follow |
| Meeting context priming | med (enables others) | med | Phase 0 |
| Missing-context injection | high | med (needs priming) | Later |
| Talk-time balance | med | med (cluster IDs live) | Later |
| Emotional state | low | low | Defer |
| Hunger / food-budget | low (demo) | low | Defer |

## Cross-notes correlations (why these priorities)

From `~/projects/teleport/planning` (Tina 6/17, Shashank 6/18) and
`~/projects/shaperotator`:

- **Topic graph is convergent, not speculative.** Tina independently asked for it
  on the 6/17 call: "real-time visualization of conversational flow… building a
  little graph, topic boundary breaks… go back a topic." And: "my thoughts are
  covered in graphs… a lot of clusters… I can ask in real time, what is this
  cluster?" Her own post-processing method is Memory → Questions → Clusters, and she
  notes "when a conversation is naturally more of a graph instead of a tree, you're
  double clicking into something." → strongest signal in the pile.
- **Late-joiner recap is already a manual workflow.** Tina: "remember when dmarz
  joined? I recap first… using Gemini to recap." Also frames the late-joiner recap
  as a *fidelity score* — how much detail survives the last two minutes.
- **Decision extraction = capturing the "why."** Shashank 6/18: "the why of a
  decision is recorded in my traces because of the conversational nature… the source
  code is just an artifact… what decisions made into reaching there is what matters."
- **Lenses over transcript is the shaperotator program pattern.** The TEE
  meeting-transcript processor extracts structured signals: blockers, collaboration
  requests, skill gaps, progress. Privacy-preserving (TEE), actionable structured
  output rather than raw transcript.
- **Privacy/consent as a product surface** (Tina): auto-delete policies, voice-print
  identity, leak-notification. Relevant to onboarding and to how transcripts are
  stored/shared.

## Harvested from dmarz session (2026-06-19, `teleport/planning/sessions/2026-06-19-dmarz-app-taps-report.html`)

Convergences (validate what we built/planned), then net-new seeds. Citations are Otter timestamps.

**Convergences:**
- "Conversation call stack" — abandoning a thread leaves a marker for "what were we just talking
  about," climb back up (Andrew 00:39). = our topic graph + late-joiner recap. 3-way convergent
  (Andrew, Tina, dmarz).
- Insight-mining report format — chunk-index → insights list → quotes at bottom → bulleted summary
  top → expanded middle (dmarz 11:27); "summary is the worst lens" (Andrew 12:09). = `insights.py`.
- Pluggable diarization + meeting-purpose context over Otter's weak labels (Andrew 00:39).
- Food-budget unlock gated on the graph showing on-topic work + hunger (dmarz 02:54) — same idea
  Andrew floated in the kickoff. Recurring → real (delight) feature.

**Net-new seeds:**
- Mention-to-recruit ("that's-fucked") buttons: tag someone → auto-email + Matrix link to pull them
  into the live meeting (dmarz 02:34).
- Ambient detector filters: real-time good-point / went-quiet detection with a celebratory surface
  (dmarz 02:54). = the live multi-lens processor + a delight layer.
- Ephemeral topic channels: bot auto-creates per-topic channels, manages membership, cleans up dead
  ones (Andrew 09:39).
- Matrix as the report surface: HTML renders natively on mobile; Slack/Telegram force downloads
  (dmarz/Andrew 09:07). Relevant — our reports are HTML.
- Self-improvement loop: Otter auto-joins via dstack, wired to Claude Code, the reader can upgrade
  itself (Andrew 23:53).
- Redaction for distribution: send the gist not the transcript; competitor names redacted on request
  (Andrew 02:11). Matches the redaction backlog item in `tasks/todo.md`.
- Edu-room wedge: grad students + professors as the adoption segment (Andrew 15:19).

## Recommended implementation target (this session)

**Conversation decoder + topic-graph view** as the spine, with **decision
extraction** as the first lens riding on it. Delivers the thing Tina asked for and
proves the one-engine architecture.

## Open questions to resolve before building

- Otter-first or Vexa-first for the decoder input? (Otter = lagged diarization but
  zero infra; Vexa = realtime + names but needs the bot running.)
- Decode incrementally (per new segment batch) vs re-decode a sliding window each
  poll? Affects NEAR call volume and graph stability.
- Where does the graph live — new panel in `otter_web/index.html`, or a separate
  view? Rendering lib (lightweight: vis-network / cytoscape / hand-rolled SVG)?
- How stable are Otter's live cluster IDs within a meeting (needed for talk-balance
  and per-speaker graph coloring)? Needs a quick probe.

## Log

- 2026-06-19: Demo of otter-integration web tool went well; DeepSeek recap > Otter
  summary. Ran exploration of otter-integration code + teleport/shaperotator notes.
  Produced this brainstorm + triage. Identified topic graph as Tina-convergent
  flagship. Next: spec the decoder + graph + decision lens.
