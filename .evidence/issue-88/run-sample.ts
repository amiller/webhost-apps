// Labeled-SAMPLE evidence harness for issue #88 (committed-screenshot path), adapted to the
// brainrot-box rename (goodpoint-box -> brainrot-box on staging) and the restructured
// GoodpointRuntime ctor (#85 added streams/traceStore/stateOverride, so typeOverride is the 6th param).
//
// Exercises the UNCHANGED production UI/endpoint render path with clearly-SYNTHETIC transcript
// text, so NO real meeting data is published (CONSTITUTION public-repo rule). The LLM verdict is
// mocked via the typeOverride seam (#88 explicitly permits mocking the LLM when no key is present
// — "LLM may be mocked if no key"). Everything upstream of the verdict (transcript text, windowing,
// throttle, event push, /conv-type, /events, UI band) is the unchanged production path.
//
// Two servers: :8942 renders the FILLED band (verdict fired); :8943 renders the EMPTY band
// (no verdict fired → the quiet "listening…" line). Driven by the envoy real browser for screenshots.
import { GoodpointRuntime } from "../../brainrot-box/server.ts";
import handler from "../../brainrot-box/server.ts";

// Clearly synthetic — NOT real meeting data.
const SAMPLE = [
  "ok, standup — yesterday I shipped the shared oauth3Connect helper and got it merged",
  "today I'll verify the conversation-type readout renders against real otter data on staging",
  "my only blocker is the shared envoy screenshot bridge timing out under load",
];

const env = {
  OAUTH3_CORE: "http://127.0.0.1:1", // immediate refuse — sample run uses NO live otter
  OTTER_TOKEN: "sample-no-otter",
  NEAR_API_KEY: "mock-no-near-key", // never used: typeOverride + judgeOverride stand in for e2ee
  CHUTES_API_KEY: "mock-no-chutes-key",
};

// Keyword classifier — a stand-in for the model ONLY (not a shipped fallback). Same shape as the
// real TYPE_SYSTEM verdict: {type, rationale}.
function classify(text: string) {
  const t = text.toLowerCase();
  if (/yesterday|today i|blocker|status|standup|shipped|reviewed|update/.test(t))
    return { type: "status-update", rationale: "progress check against prior work" };
  if (/decid|let'?s go with|we should|the call is/.test(t))
    return { type: "decision-making", rationale: "converging on a choice the group commits to" };
  if (/what if|idea|brainstorm|explore|option/.test(t))
    return { type: "brainstorming", rationale: "generating options without committing yet" };
  if (/disagree|but i think|argue|pushback|counter/.test(t))
    return { type: "debate", rationale: "competing positions tested against each other" };
  return { type: "social", rationale: "rapport and logistics, no decision in flight" };
}

function build(filled: boolean) {
  // 6 params: env, judgeOverride, streams, traceStore, stateOverride, typeOverride(#88).
  const rt = new GoodpointRuntime(env, async () => null, undefined, null, undefined, async (text) => classify(text));
  const now = Date.now();
  SAMPLE.forEach((text, i) => {
    const order = i + 1;
    rt.transcript.push({ order, text, t: now });
    rt.seen.add(order);
    rt.push({ type: "segment", segment: { order, text, t: now } });
  });
  rt.cursor = SAMPLE.length;
  return rt;
}

// FILLED: fire one verdict so the band renders the filled state before the first /events poll.
const filled = build(true);
await filled.convTypeRecent(true);
Deno.serve({ port: 8942, hostname: "0.0.0.0" }, (req) => handler(req, { runtime: filled }));
console.log("SAMPLE evidence server (FILLED) on :8942");

// EMPTY: no verdict fired → band stays on the quiet "listening…" line.
const empty = build(false);
Deno.serve({ port: 8943, hostname: "0.0.0.0" }, (req) => handler(req, { runtime: empty }));
console.log("SAMPLE evidence server (EMPTY) on :8943");
console.log("labeled sample data, mocked LLM (no live data, no NEAR key) — #88 permits the mock");
