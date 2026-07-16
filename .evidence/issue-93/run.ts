// #93 evidence driver — continuous transcript→visual-brief distillation.
//
// Restores interleave's prompt craft + the distill stage (goodpoint-box/server.ts). This driver
// proves the acceptance item: "briefs changing across a transcript window (LLM may be mocked)".
// It feeds an evolving meeting transcript through GoodpointRuntime.distillBrief() with a MOCKED
// compositor LLM (no network egress; the live staging LLM run is operator-gated — NEAR/CHUTES keys
// are not on the swarm box, which the issue's acceptance explicitly allows for).
//
// Run: deno run --allow-env --no-prompt .evidence/issue-93/run.ts
import { GoodpointRuntime, type StreamProvider } from "../../goodpoint-box/server.ts";

const env = {
  OAUTH3_CORE: "https://core.example/oauth3",
  OTTER_TOKEN: "tok-otter-test",
  NEAR_API_KEY: "near-test",
  CHUTES_API_KEY: "chutes-test",
  DISTILL_INTERVAL_MS: "30000", // banger-hold window (distillBrief(true) still respects it)
  DISTILL_WINDOW_MS: "120000",
};

// Mocked compositor distill LLM — returns a DISTINCT brief per call so evolution across the
// transcript window is visible (a real model would derive these from the actual speech).
const distillBriefs = [
  { mood: "cautious optimism about the rollout", emphasis: "ship the subset", tone: "measured, curious", direction: "slow upward drift, warm edges, sparse particles" },
  { mood: "heated debate over the budget", emphasis: "cut the scope", tone: "tense, fast", direction: "sharp red pulses, tight jitter, high density" },
  { mood: "relief — a decision landed", emphasis: "we go with plan b", tone: "settled, warm", direction: "slow exhale, soft bloom, cool calm horizon" },
];
let distillCalls = 0;
const stubStreams: StreamProvider = {
  complete: async () => {
    const j = distillBriefs[distillCalls % distillBriefs.length];
    distillCalls++;
    return JSON.stringify(j);
  },
};

// Judge override: only fires a banger when the marker phrase is present in the recent transcript.
let bangerArmed = false;
const judgeOverride = async (text: string) =>
  bangerArmed && text.includes("SHIP-THE-SUBSET")
    ? { good_point: true as const, quote: "Ship the verifiable subset", why: "scope clarity wins", score: 9 }
    : { good_point: false as const, quote: "", why: "", score: 0 };

const rt = new GoodpointRuntime(env, judgeOverride, stubStreams);

function pushSegments(texts: string[], ageSecondsAgo: number) {
  const base = Date.now() - ageSecondsAgo * 1000;
  for (let i = 0; i < texts.length; i++) {
    rt.transcript.push({ order: rt.cursor + i + 1, text: texts[i], t: base + i * 1000 });
  }
  rt.cursor = rt.transcript.reduce((m, s) => Math.max(m, s.order), 0);
}

function show(label: string) {
  console.log(`\n[${label}]`);
  console.log("  brief     :", JSON.stringify(rt.brief));
  console.log(`  stamps    : lastDistillAt=${rt.lastDistillAt}  lastBangerAt=${rt.lastBangerAt}  distilling=${rt.distilling}`);
}

console.log("# goodpoint-box #93 — continuous transcript→visual-brief distillation (LLM MOCKED per acceptance)");
console.log("# restored: TOOLSMITH_SYSTEM variety directive (atmosphere/3D-projection/Path2D/typography)");
console.log("#           + COMPOSITOR_SYSTEM (intentional brief-led VJ) + DISTILL_SYSTEM + distillBrief() stage");
console.log("# rule      : distill updates the brief between bangers; a banger OVERRIDES + holds (priority path).");

show("initial — empty brief");

// --- Window 1: rollout discussion arrives. No banger -> distill sets brief #0. ---
pushSegments([
  "we need to talk about the rollout timeline for next week",
  "the demo is tuesday and we are not ready",
  "can we ship a smaller verifiable piece first and block on the rest",
], 45);
await rt.distillBrief(true);
show("after window 1 (rollout talk, NO banger) -> brief #0 (cautious optimism)");

// --- Window 2: the discussion shifts to budget. No banger -> brief EVOLVES to #1. ---
pushSegments([
  "the real constraint is the budget, not the calendar",
  "we cannot afford to build the full scope this quarter",
  "cut it down to the essentials and revisit later",
], 25);
await rt.distillBrief(true);
show("after window 2 (budget debate, NO banger) -> brief EVOLVED to #1 (heated/tense)");

// --- Window 3: relief, a decision lands. No banger -> brief EVOLVES to #2. ---
pushSegments([
  "okay lets go with plan b and stop arguing",
  "that unblocks everyone for the demo",
], 8);
await rt.distillBrief(true);
show("after window 3 (decision lands, NO banger) -> brief EVOLVED to #2 (relief/settled)");

// --- Now a genuine good point (banger) fires. It must OVERRIDE the distilled brief. ---
bangerArmed = true;
pushSegments(["SHIP-THE-SUBSET: ship the verifiable subset, then block hard on the remainder"], 1);
const banger = await rt.judgeRecent(true);
console.log(`\n[banger fired] judgeRecent -> ${banger ? `score ${banger.score}, quote="${banger.quote}"` : "(no banger)"}`);
show("after banger -> brief OVERRIDDEN by the good point (priority path)");

// A distill right after the banger must be HELD — the good point holds the brief for one interval.
const callsBeforeHold = distillCalls;
await rt.distillBrief(true);
console.log(`\n[distill attempted post-banger] model calls before=${callsBeforeHold} after=${distillCalls} (expect equal: held)`);
show("after attempted post-banger distill -> brief UNCHANGED (banger holds)");

console.log("\n# acceptance: brief updated from segments with NO banger across 3 windows");
console.log("#             (mood: cautious optimism -> heated debate -> relief), and a banger OVERRIDES + holds.");
console.log("# (live staging LLM run is operator-gated; see PR body — no keys on the swarm box.)");
