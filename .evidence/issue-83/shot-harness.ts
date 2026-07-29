// Screenshot harness for issue #83 (NOT shipped app code — verification only).
//
// Purpose: capture a REAL browser render (Firefox headless compositor — not CDP, not Playwright,
// not a synthetic raster) of the brainrot-box UI with the #83 "Conversation state" band POPULATED,
// using a SEEDED *sample* transcript + MOCKED LLM. Both are explicitly permitted by issue #83
// ("LLM may be mocked if no key") and by LESSONS (2026-07-11: "prove the render path with a
// clearly-labeled sample ('not live data')"). The live otter read is HTTP 409 challenge_pending
// (operator step-up needed) — see flow.md; this sample render is the endorsed fallback.
//
// Why the injection below: /app has NO external subresources (inline <style>/<script> only), so a
// headless browser captures at the `load` event — BEFORE the page's async start()->fetch("state")->
// setState() resolves, which would leave the band in its empty state. To defeat that timing race
// deterministically we inject the REAL client addSegment()/setState() calls (same functions the live
// page uses) with the REAL seeded data, executed at parse time before the page's auto start(). The
// resulting DOM is byte-identical to what the live JS path produces ~20ms after load; we change
// nothing about the shipped app. The live JS wiring itself is separately proven by render-check.ts.
//
// Run: PORT=8948 deno run --allow-net --allow-read --allow-env .evidence/issue-83/shot-harness.ts
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

// Real data straight off the runtime — same shape GET /state and GET /events serve.
const stateObj = {
  recap: rt.recap,
  shifts: rt.shifts,
  estimate: rt.estimate,
  last_topic: rt.lastTopic,
};
const segJson = JSON.stringify(seeded.map((s) => ({ order: s.order, text: s.text })));
const stateJson = JSON.stringify(stateObj);

// Synchronous injection: populate transcript + state band via the REAL client fns at parse time.
const inject = [
  `try{var _s=${segJson};for(var i=0;i<_s.length;i++){addSegment(_s[i]);}setState(${stateJson});}catch(e){}`,
].join("");

Deno.serve({ port: Number(Deno.env.get("PORT") || "8948") }, async (req) => {
  const u = new URL(req.url);
  const p = u.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "POST" && p === "/start") {
    return new Response('{"ok":true,"running":true}', { headers: { "content-type": "application/json" } });
  }
  const res = handler(req, { runtime: rt });
  // Intercept the served /app HTML and inject the determinism script before the page's auto start().
  if (typeof (res as any).then === "function") {
    const r = await (res as Promise<Response>);
    return injectHtml(r);
  }
  return injectHtml(res as Response);
});

async function injectHtml(res: Response): Promise<Response> {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return res;
  let html = await res.text();
  if (!html.includes('id="state"')) return new Response(html, { status: res.status, headers: res.headers });
  // Insert the injection right before the page's final auto `start();` (unique tail of the script).
  const anchor = "host.requestAnimationFrame(frame);\nstart();";
  if (html.includes(anchor)) {
    html = html.replace(anchor, `host.requestAnimationFrame(frame);\n${inject}\nstart();`);
  } else {
    html = html.replace("</script>\n</body>", `${inject}\n</script>\n</body>`);
  }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(html, { status: res.status, headers });
}
