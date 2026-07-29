// Local render-check harness for issue #83 (NOT shipped app code — verification only).
// Proves the conversation-state render path end-to-end with the REAL handler + REAL public/index.html,
// a SEEDED *sample* transcript (not live data) and a MOCKED LLM. Both are permitted by issue #83:
//   "LLM may be mocked if no key" and "log or PNG evidence committed".
// /start is stubbed so the live otter/llm loops don't spin against absent keys.
//
// Run: deno run --allow-net --allow-read --allow-env .evidence/issue-83/render-check.ts
import handler, {
  GoodpointRuntime,
  normalizeSegments,
  type StateKind,
} from "../../brainrot-box/server.ts";

const env = {
  OAUTH3_CORE: "http://127.0.0.1:1",
  OTTER_TOKEN: "tok-seed",
  NEAR_API_KEY: "near-seed",
  CHUTES_API_KEY: "chutes-seed",
};

// brainrot-box ctor: (env, judgeOverride?, streams?, traceStore?, stateOverride?).
// null traceStore -> no disk writes; stateOverride -> no e2ee key needed.
const rt = new GoodpointRuntime(env, undefined, undefined, null, async (kind: StateKind) => {
  if (kind === "recap") return '{"recap":"the team is deciding the deploy window for the oauth3 rollout"}';
  if (kind === "shift") return '{"shifted":true,"topic":"oauth3 rollout window"}';
  return '{"audience":"core eng","purpose":"decide the rollout","register":"working"}';
});

const seeded = normalizeSegments({ segments: [
  { order: 1, text: "Alright, we need to lock the deploy window for the oauth3 rollout." },
  { order: 2, text: "The staging gate requires real evidence before we ship anything." },
  { order: 3, text: "Let's pick Thursday morning so the operator can review the promotion step." },
] });
for (const s of seeded) {
  rt.transcript.push(s);
  rt.push({ type: "segment", segment: s });
}
await rt.stateRecent(true);

Deno.serve({ port: Number(Deno.env.get("PORT") || "8947") }, (req) => {
  const u = new URL(req.url);
  const p = u.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "POST" && p === "/start") {
    return new Response('{"ok":true,"running":true}', { headers: { "content-type": "application/json" } });
  }
  return handler(req, { runtime: rt });
});
