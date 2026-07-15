# Spec: conversation decoder + topic graph + decision lens

Build target locked 2026-06-19: **Otter-first**, **decoder + topic-graph view +
decision lens**. Rides on the existing `otter_web/` server and NEAR call. See
`conversation-tooling-brainstorm.md` for the why and the one-engine architecture.

## Data we already have (verified)

Otter `GET /speech` → `speech.transcripts[]`, each segment:
- `uuid` — stable per segment (use as node id)
- `order` — monotonic ordering / poll cursor
- `transcript` — the text
- `label` — speaker **cluster id** (live; human names settle post-meeting)

Current `/live` forwards only `{order, text}` and the client keeps only text
strings. **Change 1:** forward `uuid` and `label` too.

## Architecture: server-side incremental decode with state

The server is currently stateless (every request rebuilds the Otter session). The
graph needs to persist across 8s polls, so add per-meeting state:

```
STATE = {}   # otid -> {"topics": {topic_label: topic_id},
             #          "nodes": [ ... ], "decoded": set(uuid), "cursor": order}
```

### Decode step (per /graph poll)
1. Live speech → full `transcripts`, sorted by `order`.
2. New segments = those whose `uuid` not in `STATE[otid]["decoded"]`.
3. Batch trigger: only call NEAR when ≥4 new non-empty segments accumulated (keeps
   token volume sane; otherwise return current graph unchanged).
4. NEAR decode call (text model, temp ~0.2): pass the list of currently-open topic
   labels + the new raw segments (`[label] text`). Model returns JSON only:

```json
{ "nodes": [
  { "uuid": "<segment uuid>", "speaker": "S1", "kind": "topic|question|point|decision|divergence|action_item|aside",
    "text": "<short canonical phrasing>", "topic": "<short topic label>",
    "rel": "new-topic|continues|reply-to|digression|resolves" } ] }
```

5. Server assigns/reuses `topic_id` per `topic` label, appends nodes, marks uuids
   decoded, advances cursor.
6. Edges are derived server-side: sequential `rel` between consecutive nodes +
   membership in a topic cluster.

Errors propagate (no fallback): a malformed JSON from NEAR raises and surfaces in
the `/graph` error field, same pattern as `/recap`.

### Endpoint
`GET /graph?after=<node_index>` →
```json
{ "live": true, "title": "...",
  "topics": [ {"id": "t3", "label": "deployment strategy", "node_ids": [...]} ],
  "nodes":  [ {"id","speaker","kind","text","topic_id","rel"} ],
  "decisions": [ <node ids where kind in {decision, action_item, point}> ] }
```
`decisions` is just a filtered view over `nodes` — the decision lens is a query, not
a second pipeline.

## Client (index.html)

Add a graph panel. Proposal: **cytoscape.js via CDN** (internet is already required
for NEAR), using compound nodes = topic clusters containing segment nodes. Fits the
"clusters of thoughts" framing Tina described.

- Nodes colored by `kind` (topic / question / point / decision / divergence).
- Compound parent per topic → visually groups a cluster.
- Click a node → show its text + speaker.
- **Click a topic cluster → recap just that cluster** (reuse `/recap` with the
  cluster's segment text). This directly answers Tina's "what is this cluster?" and
  "go back a topic."
- A thin **decisions rail** (list) that accretes decision/action nodes as they form.
- Keep the existing transcript feed + recap button; graph is an added view (tab or
  third column), not a replacement.

Poll cadence stays 8s; `/graph` returns fast (unchanged graph) on polls that don't
trigger a decode.

## Probes to run during build
- Confirm `label` cluster ids stay stable within a meeting (needed for per-speaker
  coloring and later talk-balance). If they re-cluster mid-meeting, color by latest.
- Measure decode latency on a real 4-segment batch (NEAR text model) to tune the
  batch threshold.

## Out of scope for this session
Late-joiner recap, agenda-coverage diff, missing-context injection, talk-balance,
Vexa input path. All become small queries/views once the decoder + graph land.
