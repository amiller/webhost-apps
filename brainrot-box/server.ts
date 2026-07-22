import vm from "node:vm";
import { nearStream } from "./near_e2ee.ts";
import { chutesStream } from "./chutes_e2ee.ts";

type Env = Record<string, string | undefined>;

interface Cfg {
  oauth3Core: string;
  otterToken: string;
  nearKey: string;
  chutesKey: string;
  toolsmithModel: string;
  compositorModel: string;
  weaveIdleMs: number;
  otterIdleMs: number;
  sttBase: string;
  sttModel: string;
}

export interface GraphNode {
  id: number;
  kind: "topic" | "question" | "point" | "decision" | "divergence" | "action_item" | "aside";
  label: string;
  topic: string;
  text: string;
  t: number;
}

interface Segment {
  order: number;
  text: string;
  speaker?: string;
  t: number;
}

export interface GoodPoint {
  t: number;
  quote: string;
  why: string;
  score: number;
}

interface ToolDef {
  name: string;
  desc: string;
  params: { name: string; default: number; min: number; max: number }[];
  draw: string;
}

export interface JudgeResult {
  good_point: boolean;
  quote: string;
  why: string;
  score: number;
}

/** Optional model-stream injection (tests): when set, `streamComplete` calls this instead of
 *  the real NEAR/Chutes e2ee paths, so loops can be exercised with no network egress. */
export interface StreamProvider {
  complete(
    model: string,
    system: string,
    user: string,
    maxTokens: number,
    onDelta: (t: string) => void,
    signal?: AbortSignal,
  ): Promise<string>;
}

// Prompts ported verbatim from interleave (cue/examples/interleave-demo/server.pod.ts) — the
// compressed one-liners that shipped in PR #84 produced visibly flat output.
const TOOLSMITH_SYSTEM = `You are a coding agent that builds a library of small VISUAL LAYER TOOLS for a
realtime canvas compositor. Each turn you create ONE new tool — or improve an existing one — that a
faster model will attach, parameterize, and tweak live.

A tool is a self-contained animated draw function for a 2D canvas:
- signature: (ctx, p, t, w, h, txt) — ctx is CanvasRenderingContext2D, p is the params object, t is time
  in seconds (USE t to animate continuously), w and h are canvas pixels, and txt is a live string of
  recent room speech (a caption you MAY render).
- declares 2-5 numeric params the compositor can tweak (speed, density, hue, scale, intensity, depth, ...),
  each with a sensible default and min/max.
- composites well over other layers — lean on ctx.globalAlpha for blendability.

BUILD A VARIETY — do not just make particles and text. Rotate through these kinds:
- ATMOSPHERE: starfields, drifting fog, aurora, rain, ripples, pulsing grids, sweeping beacons, neon contours.
- 3D / SCENES: rotate points in XYZ and project to 2D (sx = w/2 + x*f/(f+z), sy = h/2 + y*f/(f+z), f≈300)
  to draw wireframe or shaded SOLIDS (cube, icosahedron, torus), perspective tunnels/corridors,
  depth-sorted point clouds, parallax horizons, isometric structures. Give them a depth or rotation param.
- VECTOR / SVG: build little emblems, glyphs, sigils or line-art from SVG path data via Path2D —
  const path = new Path2D("M12 2 L22 22 ..."); then ctx.fill(path) / ctx.stroke(path) under a transform,
  animating the transform (translate/rotate/scale) over t.
- TEXT: render txt (the live caption) as styled, animated typography (font, size, motion, color, layout).

Respond with STRICT JSON only, no markdown fences:
{"name":"snake_name","desc":"one line","params":[{"name":"speed","default":1,"min":0,"max":3}],"draw":"(ctx,p,t,w,h,txt)=>{ /* ... */ }"}

Keep the draw body COMPACT — under ~40 lines, no nested named helpers, no comments.
Use only the canvas 2D API (including Path2D) and Math. NO per-pixel loops, no getImageData/putImageData,
no DOM, window, document, network, or imports.

CRAFT — luminous accents over a DARK field; the night must stay night:
- Spread across the WHOLE frame (elements spanning w and h, or a SUBTLE translucent gradient wash) —
  never one lone centered shape, but luminous elements should cover roughly a third of the canvas,
  not flood it. Black space is part of the composition.
- Glow: ctx.shadowBlur (10-40) + shadowColor matching the stroke. globalCompositeOperation='lighter'
  is allowed but ONLY with globalAlpha <= 0.5 and lightness <= 60% — additive stacking must not
  accumulate to white.
- NEVER call clearRect or paint an opaque full-frame fill — your layer sits in a STACK and must read
  over whatever is below (translucent washes are fine).`;

const COMPOSITOR_SYSTEM = `You are a realtime VJ compositor. You have a palette of visual layer tools built
by a coding agent, and a BRIEF distilled from the live room (mood, tone, a creative direction). Each turn you
output a COMPOSITION: an ordered stack of layers (back to front) chosen from the palette, each with parameter
values.

Be INTENTIONAL, not random. Realize the brief: let the TONE pick the palette and energy (calm→slow/sparse/cool,
intense→fast/dense/hot) and let the DIRECTION decide what should move and what to emphasize. Pick layers that
genuinely express it rather than nudging whatever was already on screen. Evolve from the previous composition so
it stays alive, but the brief leads.

Respond with STRICT JSON only, no markdown:
{"layers":[{"tool":"name","params":{"speed":1.2,"hue":210}}]}

Only use tool names from the palette. 2-5 layers, each tool AT MOST ONCE per composition — vary the
palette, don't stack one tool on itself. Atmosphere at the BACK, structure in the middle, accents in
front. Keep intensity/alpha params modest (<=1): layers add up, and blown-out white is failure.`;

const DECODER_SYSTEM = `You decode a meeting transcript into a typed conversation graph. You get the
topics already open and a batch of new numbered segments. Emit one node per SUBSTANTIVE segment; skip
pure filler/backchannel ('yeah', 'right'). Kinds: topic (frames a subject), question, point (a
substantive claim/idea), decision (something agreed/chosen), divergence (a tangent/disagreement),
action_item (a to-do), aside. Give each node a short label (<=8 words) and a topic, REUSING an open
topic label verbatim when it fits, else a new short label. When the SUBJECT clearly changes
("switching to", "now about", a different domain), OPEN A NEW topic — never stretch an old label to
cover a new subject; distinct subjects get distinct topics even within one batch.
Return STRICT JSON only: {"nodes":[{"seg":<segment number>,"kind":"point","label":"...","topic":"..."}]}`;

// Ported verbatim from interleave — the artistic brief between bangers. Without it (PR #84
// dropped it) the compositor only ever saw the formulaic banger brief, and output flattened.
const DISTILL_SYSTEM = `From a live-room transcript (may have fragments/mis-hears), design a VISUAL BRIEF. First pick the few highlights that actually matter (the key phrases, the turn of the discussion) and read the tone (emotional register + energy). Then translate that into a concrete plan for abstract visuals. Output STRICT JSON: {"mood":"one evocative line (<=14 words) to steer visuals by","emphasis":"the single most important short phrase to show on screen (<=6 words)","tone":"emotional register + energy (<=8 words, e.g. 'hushed, reflective' or 'rising, electric')","direction":"a thoughtful effect plan grounded in the highlights + tone: what should move, how, what to emphasize (<=24 words)"}. Ignore filler and noise.`;

const JUDGE_SYSTEM = `You judge a live meeting transcript for genuinely useful "good points".
Return STRICT JSON only:
{"good_point":bool,"quote":"<=140 chars near-verbatim","why":"<=12 words","score":0-10}
Flag only concise, reusable insights, decisions, or unusually clear framing. Ignore filler, logistics, and vague agreement.`;

const JSON_H = { "content-type": "application/json", "cache-control": "no-store" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: JSON_H });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function extractJson(s: string): unknown {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

export function parseJudge(raw: string): JudgeResult | null {
  const j = extractJson(raw) as Partial<JudgeResult> | null;
  if (!j || typeof j !== "object") return null;
  const score = Math.max(0, Math.min(10, Number(j.score)));
  const quote = String(j.quote ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  const why = String(j.why ?? "").replace(/\s+/g, " ").trim().split(/\s+/).slice(0, 12).join(" ");
  return {
    good_point: j.good_point === true,
    quote,
    why,
    score: Number.isFinite(score) ? score : 0,
  };
}

export interface Scored {
  text: string;
  confidence: number;
  drop: boolean;
}

// Ported verbatim from interleave's scoreTranscript.
export function scoreTranscript(data: any): Scored {
  const text = String(data.text ?? "").replace(/\s+/g, " ").trim();
  const segs: any[] = data.segments ?? [];
  if (!text) return { text: "", confidence: 0, drop: true };
  if (!segs.length) return { text, confidence: 0.4, drop: false };
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const noSpeech = avg(segs.map((s) => s.no_speech_prob ?? 0));
  const logprob = avg(segs.map((s) => s.avg_logprob ?? -1));
  const comp = Math.max(...segs.map((s) => s.compression_ratio ?? 1));
  const confidence = Math.max(0, Math.min(1, (logprob + 1.5) / 1.5)) * (1 - noSpeech);
  const drop = confidence < 0.5 || noSpeech > 0.55 || comp > 2.4 || text.replace(/[^a-z]/gi, "").length < 3;
  return { text, confidence, drop };
}

export function isBanger(j: JudgeResult | null): j is JudgeResult {
  return !!j && j.good_point && j.score >= 7 && j.quote.length > 0;
}

export function normalizeSegments(data: unknown, now = Date.now()): Segment[] {
  const root = (data && typeof data === "object" && "data" in data) ? (data as any).data : data as any;
  const raw = Array.isArray(root?.segments) ? root.segments
    : Array.isArray(root?.transcript) ? root.transcript
    : Array.isArray(root?.items) ? root.items
    : [];
  return raw.map((s: any, i: number) => {
    const order = Number(s.order ?? s.index ?? s.seq ?? s.id ?? i);
    const text = String(s.text ?? s.transcript ?? s.content ?? "").replace(/\s+/g, " ").trim();
    const speaker = s.speaker || s.speakerName || s.user || undefined;
    return { order, text, speaker, t: Number(s.t ?? s.ts ?? s.timestamp ?? now) || now };
  }).filter((s: Segment) => Number.isFinite(s.order) && s.text);
}

export function mergeOtterSegments(
  current: Segment[],
  incoming: Segment[],
  seen: Set<number>,
): { added: Segment[]; cursor: number } {
  const added: Segment[] = [];
  let cursor = current.reduce((m, s) => Math.max(m, s.order), 0);
  for (const seg of incoming) {
    cursor = Math.max(cursor, seg.order);
    if (seen.has(seg.order)) continue;
    seen.add(seg.order);
    current.push(seg);
    added.push(seg);
  }
  const cutoff = Date.now() - 5 * 60_000;
  while (current.length && current[0].t < cutoff) current.shift();
  return { added, cursor };
}

function requireCfg(env: Env): Cfg {
  const get = (k: string) => {
    if (env[k]) return env[k]!;
    try {
      return Deno.env.get(k) ?? "";
    } catch {
      return "";
    }
  };
  const cfg: Cfg = {
    oauth3Core: (get("OAUTH3_CORE") || get("OAUTH3_NODE")).replace(/\/+$/, ""),
    otterToken: get("OTTER_TOKEN") || get("OAUTH3_TOKEN"),
    nearKey: get("NEAR_API_KEY") || get("NEAR_KEY"),
    chutesKey: get("CHUTES_API_KEY"),
    toolsmithModel: get("TOOLSMITH_MODEL") || "deepseek-ai/DeepSeek-V4-Flash",
    compositorModel: get("COMPOSITOR_MODEL") || "unsloth/Mistral-Nemo-Instruct-2407-TEE",
    weaveIdleMs: Number(get("WEAVE_IDLE_MS")) || 3 * 60_000,
    otterIdleMs: Number(get("OTTER_IDLE_MS")) || 10 * 60_000,
    sttBase: (get("TRANSCRIBE_BASE_URL") || get("NEAR_BASE") || "https://cloud-api.near.ai/v1").replace(/\/+$/, ""),
    sttModel: get("TRANSCRIBE_MODEL") || "openai/whisper-large-v3",
  };
  const missing = [
    ["OAUTH3_CORE", cfg.oauth3Core],
    ["OTTER_TOKEN", cfg.otterToken],
    ["NEAR_API_KEY", cfg.nearKey],
    ["CHUTES_API_KEY", cfg.chutesKey],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`missing required env: ${missing.join(", ")}`);
  return cfg;
}

async function readPublic(name: string): Promise<Response> {
  try {
    const body = await Deno.readTextFile(new URL(`./public/${name}`, import.meta.url));
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return new Response("not found", { status: 404 });
    throw e;
  }
}

export class GoodpointRuntime {
  cfg: Cfg;
  transcript: Segment[] = [];
  ledger: GoodPoint[] = [];
  seen = new Set<number>();
  cursor = 0;
  lastFetchOk = false;
  lastFetchErr = "";
  lastFetchAt = 0;
  lastJudgeAt = 0;
  registry = new Map<string, ToolDef>();
  composition: unknown = { layers: [] };
  brief = { mood: "", emphasis: "", tone: "", direction: "" };
  events: { seq: number; ev: unknown }[] = [];
  seq = 0;
  // master on/off (set by /start or /app load). `running` stays as a back-compat read of this.
  enabled = false;
  // two independent lanes: the weave (toolsmith+compositor) can idle while otter+judge keep
  // watching a live meeting. Each lane has its own AbortController + running flag.
  weaveRunning = false;
  otterRunning = false;
  // idle bookkeeping. lastConsumerAt = last /events poll (a viewer is watching);
  // lastLiveAt = last live-meeting signal or freshly-arrived speech segment.
  lastConsumerAt = 0;
  lastLiveAt = 0;
  lastWeaveIdleAt = 0;
  lastOtterIdleAt = 0;
  weaveIdleReason = "";
  otterIdleReason = "";
  private weaveAC: AbortController | null = null;
  private otterAC: AbortController | null = null;
  private supervisorAC: AbortController | null = null;
  // mic lane + conversation graph
  micSeq = 0;
  graphNodes: GraphNode[] = [];
  graphTopics: string[] = [];
  decodeQueue: Segment[] = [];
  decodedCount = 0;
  lastDecodeAt = 0;
  private nodeSeq = 0;
  private judgeOverride?: (text: string) => Promise<JudgeResult | null>;
  private streams?: StreamProvider;

  constructor(
    env: Env,
    judgeOverride?: (text: string) => Promise<JudgeResult | null>,
    streams?: StreamProvider,
  ) {
    this.cfg = requireCfg(env);
    this.judgeOverride = judgeOverride;
    this.streams = streams;
  }

  get running(): boolean {
    return this.enabled;
  }

  push(ev: unknown): void {
    this.events.push({ seq: ++this.seq, ev });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
  }

  async pollOtter(signal?: AbortSignal): Promise<Segment[]> {
    const r = await fetch(`${this.cfg.oauth3Core}/api/otter/live?after=${this.cursor}`, {
      headers: { Authorization: `Bearer ${this.cfg.otterToken}` },
      signal,
    });
    this.lastFetchAt = Date.now();
    if (!r.ok) {
      this.lastFetchOk = false;
      this.lastFetchErr = `otter ${r.status}: ${(await r.text()).slice(0, 180)}`;
      throw new Error(this.lastFetchErr);
    }
    const data = await r.json();
    const live = data?.live === true || data?.data?.live === true;
    const { added, cursor } = mergeOtterSegments(this.transcript, normalizeSegments(data), this.seen);
    this.cursor = cursor;
    this.lastFetchOk = true;
    this.lastFetchErr = "";
    // a live meeting or freshly-arrived speech keeps the otter lane awake (#90)
    if (live || added.length) this.lastLiveAt = Date.now();
    for (const seg of added) this.push({ type: "segment", segment: seg });
    this.decodeQueue.push(...added);
    return added;
  }

  // Scored transcription, ported verbatim from interleave: verbose_json + language pin gives
  // whisper's per-segment stats; silence/hallucination clips are DROPPED, not ingested.
  async transcribe(audio: Uint8Array): Promise<Scored> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const form = new FormData();
      form.append("model", this.cfg.sttModel);
      form.append("response_format", "verbose_json");
      form.append("language", "en");
      form.append("file", new Blob([audio.buffer as ArrayBuffer], { type: "audio/wav" }), "clip.wav");
      const r = await fetch(`${this.cfg.sttBase}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.nearKey}` },
        body: form,
      });
      if (r.ok) return scoreTranscript(await r.json());
      const body = await r.text().catch(() => "");
      if (r.status >= 500 && attempt < 2) {
        await delay(500);
        continue;
      }
      throw new Error(`stt ${r.status}: ${body.slice(0, 180)}`);
    }
    return { text: "", confidence: 0, drop: true };
  }

  // mic speech enters the SAME pipeline as otter segments: transcript, judge, graph, brief.
  async ingestSpeech(text: string): Promise<Segment> {
    const seg: Segment = { order: 1_000_000_000 + ++this.micSeq, text, speaker: "mic", t: Date.now() };
    this.seen.add(seg.order);
    this.transcript.push(seg);
    this.decodeQueue.push(seg);
    this.lastLiveAt = seg.t;
    this.push({ type: "segment", segment: seg });
    await this.judgeRecent();
    await this.distill();
    await this.decoderTurn();
    return seg;
  }

  lastDistill = 0;
  async distill(signal?: AbortSignal): Promise<void> {
    if (Date.now() - this.lastDistill < 12_000) return;
    const recent = this.recentText(45_000);
    if (recent.length < 20) return;
    this.lastDistill = Date.now();
    const raw = await this.streamComplete(
      this.cfg.compositorModel,
      DISTILL_SYSTEM,
      `Transcript:\n${recent}\n\nJSON:`,
      220,
      () => {},
      signal,
    );
    const j = extractJson(raw) as any;
    if (!j || typeof j.mood !== "string") return;
    this.brief = {
      mood: j.mood.trim(),
      emphasis: String(j.emphasis ?? "").trim(),
      tone: String(j.tone ?? "").trim(),
      direction: String(j.direction ?? "").trim(),
    };
    this.push({ type: "brief", brief: this.brief });
  }

  async decoderTurn(signal?: AbortSignal): Promise<void> {
    const pending = this.decodeQueue.slice(this.decodedCount);
    if (!pending.length) return;
    if (pending.length < 3 && Date.now() - this.lastDecodeAt < 30_000) return;
    const batch = pending.slice(0, 12);
    this.lastDecodeAt = Date.now();
    const open = this.graphTopics.slice(-8).join(", ") || "(none yet)";
    const lines = batch.map((s) => `${s.order}: ${s.text}`).join("\n");
    const raw = await this.streamComplete(
      this.cfg.toolsmithModel,
      DECODER_SYSTEM,
      `Open topics: ${open}\nSegments:\n${lines}\n\nJSON:`,
      600,
      () => {},
      signal,
    );
    const j = extractJson(raw) as any;
    if (!j || !Array.isArray(j.nodes)) {
      this.push({ type: "activity", who: "decoder", state: "parse miss" });
      return;
    }
    const byOrder = new Map(batch.map((s) => [s.order, s]));
    for (const n of j.nodes) {
      const seg = byOrder.get(Number(n?.seg));
      const kinds = ["topic", "question", "point", "decision", "divergence", "action_item", "aside"];
      if (!seg || !kinds.includes(n?.kind)) continue;
      const topic = String(n.topic ?? "").trim() || "misc";
      if (!this.graphTopics.includes(topic)) this.graphTopics.push(topic);
      const node: GraphNode = {
        id: ++this.nodeSeq,
        kind: n.kind,
        label: String(n.label ?? "").trim().slice(0, 80) || seg.text.slice(0, 60),
        topic,
        text: seg.text.slice(0, 200),
        t: seg.t,
      };
      this.graphNodes.push(node);
      this.push({ type: "graphnode", node });
    }
    this.decodedCount += batch.length;
  }

  recentText(windowMs: number): string {
    const since = Date.now() - windowMs;
    return this.transcript.filter((s) => s.t >= since).map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  }

  async streamComplete(model: string, system: string, user: string, maxTokens: number, onDelta = (_: string) => {}, signal?: AbortSignal): Promise<string> {
    if (this.streams) return await this.streams.complete(model, system, user, maxTokens, onDelta, signal);
    const body = { max_tokens: maxTokens, temperature: 0.25, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    let content = "";
    const cb = (t: string) => {
      content += t;
      onDelta(t);
    };
    if (model.endsWith("-TEE")) await chutesStream(this.cfg.chutesKey, model, body, cb, signal);
    else await nearStream(this.cfg.nearKey, model, body, cb, signal);
    return content;
  }

  async judgeRecent(force = false): Promise<GoodPoint | null> {
    if (!force && Date.now() - this.lastJudgeAt < 15_000) return null;
    const text = this.recentText(60_000);
    if (text.length < 20) return null;
    this.lastJudgeAt = Date.now();
    const judge = this.judgeOverride
      ? await this.judgeOverride(text)
      : parseJudge(await this.streamComplete(this.cfg.toolsmithModel, JUDGE_SYSTEM, `Transcript:\n${text}\n\nJSON:`, 180));
    if (!isBanger(judge)) return null;
    const point = { t: Date.now(), quote: judge.quote, why: judge.why, score: judge.score };
    this.ledger.push(point);
    if (this.ledger.length > 80) this.ledger.splice(0, this.ledger.length - 80);
    this.brief = {
      mood: `good point: ${point.quote}`,
      emphasis: point.quote,
      tone: point.why || "sharp, useful",
      direction: `Make the banger legible and steer the motion around: ${point.quote}`,
    };
    this.push({ type: "goodpoint", point, brief: this.brief });
    return point;
  }

  smokeTest(tool: ToolDef): string | null {
    if (/\bclearRect\b/.test(tool.draw)) return "clearRect erases the layers below — draw over them instead";
    const grad = { addColorStop() {} };
    const ctx = new Proxy({} as any, {
      get(o, k) {
        if (k in o) return o[k];
        if (k === "createLinearGradient" || k === "createRadialGradient" || k === "createPattern") return () => grad;
        if (k === "measureText") return (t: string) => ({ width: Math.max(1, String(t).length) * 8 });
        return () => {};
      },
      set(o, k, v) {
        o[k] = v;
        return true;
      },
    });
    const params = Object.fromEntries(tool.params.map((p) => [p.name, p.default]));
    const Path2D = class { constructor(_?: string) {} addPath() {} };
    try {
      vm.runInNewContext(`const fn=(${tool.draw}); fn(ctx,params,0,800,600,"sample"); fn(ctx,params,1,800,600,"sample");`, { ctx, params, Path2D }, { timeout: 500 });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async toolsmithTurn(signal: AbortSignal): Promise<void> {
    this.push({ type: "activity", who: "toolsmith", state: "thinking" });
    const existing = [...this.registry.keys()].join(", ") || "(none)";
    // stream the build so the workflow tab can show code being written live (interleave-style)
    let deltaBuf = "";
    let lastFlush = Date.now();
    const flush = () => {
      if (!deltaBuf) return;
      this.push({ type: "build-delta", text: deltaBuf });
      deltaBuf = "";
      lastFlush = Date.now();
    };
    const raw = await this.streamComplete(
      this.cfg.toolsmithModel,
      TOOLSMITH_SYSTEM,
      `Existing tools: ${existing}\nBrief: ${JSON.stringify(this.brief)}\nBuild one distinct compact layer tool. JSON only:`,
      1600,
      (t) => {
        deltaBuf += t;
        if (deltaBuf.length > 120 || Date.now() - lastFlush > 400) flush();
      },
      signal,
    );
    flush();
    const tool = extractJson(raw) as ToolDef | null;
    if (!tool || typeof tool.name !== "string" || typeof tool.draw !== "string" || !Array.isArray(tool.params)) {
      this.push({ type: "activity", who: "toolsmith", state: "parse miss" });
      return;
    }
    const err = this.smokeTest(tool);
    if (err) {
      this.push({ type: "activity", who: "toolsmith", state: `rejected ${tool.name}` });
      return;
    }
    const updated = this.registry.has(tool.name);
    this.registry.set(tool.name, tool);
    this.push({ type: "tool", tool, updated });
  }

  async compositorTurn(signal: AbortSignal): Promise<void> {
    if (!this.registry.size) {
      this.push({ type: "activity", who: "compositor", state: "waiting for tools" });
      return;
    }
    this.push({ type: "activity", who: "compositor", state: "composing" });
    const palette = [...this.registry.values()].map((t) => `${t.name}(${t.params.map((p) => p.name).join(",")}) - ${t.desc}`).join("\n");
    const raw = await this.streamComplete(
      this.cfg.compositorModel,
      COMPOSITOR_SYSTEM,
      `Palette:\n${palette}\n\nBrief:\n${JSON.stringify(this.brief)}\n\nCurrent: ${JSON.stringify(this.composition)}\n\nJSON:`,
      400,
      () => {},
      signal,
    );
    const comp = extractJson(raw) as any;
    if (!comp || !Array.isArray(comp.layers)) {
      this.push({ type: "activity", who: "compositor", state: "parse miss" });
      return;
    }
    const seenTools = new Set<string>();
    comp.layers = comp.layers
      .filter((l: any) => l && this.registry.has(l.tool) && !seenTools.has(l.tool) && seenTools.add(l.tool))
      .slice(0, 5);
    if (!comp.layers.length) return;
    this.composition = comp;
    this.push({ type: "composition", layers: comp.layers });
  }

  // A viewer polled /events -> they are watching. Refresh the heartbeat and, if the weave lane
  // was idled, resume it now. (The otter/judge lane is resumed by /start or /app load.)
  resumeConsumer(): void {
    this.lastConsumerAt = Date.now();
    if (this.enabled && !this.weaveRunning) this.startWeave();
  }

  // One synchronous idle decision (testable without realtime): stop a lane whose keepalive
  // window expired. Restarts are viewer/app-driven (resumeConsumer / start), never here.
  tickIdle(now = Date.now()): void {
    if (this.weaveRunning && now - this.lastConsumerAt > this.cfg.weaveIdleMs) {
      this.stopWeave(`no /events poller for ${Math.round((now - this.lastConsumerAt) / 1000)}s`);
    }
    if (this.otterRunning && now - this.lastLiveAt > this.cfg.otterIdleMs) {
      this.stopOtter(`no live speech for ${Math.round((now - this.lastLiveAt) / 1000)}s`);
    }
  }

  // master on: a viewer hit /start or loaded /app -> resume everything.
  start(): void {
    this.enabled = true;
    const now = Date.now();
    if (!this.lastConsumerAt) this.lastConsumerAt = now;
    if (!this.lastLiveAt) this.lastLiveAt = now;
    this.startOtter();
    this.startWeave();
    this.startSupervisor();
  }

  // master off: stop everything.
  stop(): void {
    this.enabled = false;
    this.stopWeave("stopped");
    this.stopOtter("stopped");
    this.stopSupervisor();
  }

  private startWeave(): void {
    if (this.weaveRunning) return;
    this.weaveRunning = true;
    this.weaveIdleReason = "";
    const ac = new AbortController();
    this.weaveAC = ac;
    // two independent cadences, as in interleave: a slow tool build must not freeze compositions
    const loop = async (turn: (s: AbortSignal) => Promise<void>, pause: number) => {
      while (!ac.signal.aborted) {
        try {
          await turn(ac.signal);
        } catch (e) {
          if (!ac.signal.aborted) this.push({ type: "status", text: e instanceof Error ? e.message : String(e) });
        }
        await delay(pause);
      }
    };
    loop((s) => this.toolsmithTurn(s), 1200).finally(() => {});
    loop((s) => this.compositorTurn(s), 1400).finally(() => {});
  }

  private stopWeave(reason: string): void {
    this.weaveAC?.abort();
    this.weaveAC = null;
    if (!this.weaveRunning) return;
    this.weaveRunning = false;
    this.lastWeaveIdleAt = Date.now();
    this.weaveIdleReason = reason;
    this.push({ type: "idle", lane: "weave", reason });
  }

  private startOtter(): void {
    if (this.otterRunning) return;
    this.otterRunning = true;
    this.otterIdleReason = "";
    const ac = new AbortController();
    this.otterAC = ac;
    const loop = async () => {
      while (!ac.signal.aborted) {
        try {
          const added = await this.pollOtter(ac.signal);
          if (added.length) await this.judgeRecent();
          if (added.length) await this.distill(ac.signal);
          await this.decoderTurn(ac.signal);
        } catch (e) {
          if (!ac.signal.aborted) this.push({ type: "status", text: e instanceof Error ? e.message : String(e) });
        }
        await delay(5000);
      }
    };
    loop().finally(() => {});
  }

  private stopOtter(reason: string): void {
    this.otterAC?.abort();
    this.otterAC = null;
    if (!this.otterRunning) return;
    this.otterRunning = false;
    this.lastOtterIdleAt = Date.now();
    this.otterIdleReason = reason;
    this.push({ type: "idle", lane: "otter", reason });
  }

  // watchdog: idles stale lanes. It only stops; starts happen via resumeConsumer / start.
  private startSupervisor(): void {
    if (this.supervisorAC) return;
    const ac = new AbortController();
    this.supervisorAC = ac;
    const loop = async () => {
      while (!ac.signal.aborted) {
        await delay(5000);
        if (ac.signal.aborted) break;
        this.tickIdle();
      }
    };
    loop().finally(() => {});
  }

  private stopSupervisor(): void {
    this.supervisorAC?.abort();
    this.supervisorAC = null;
  }
}

let runtime: GoodpointRuntime | null = null;
function getRuntime(env: Env): GoodpointRuntime {
  runtime ??= new GoodpointRuntime(env);
  return runtime;
}

export default async function handler(req: Request, ctx?: { env?: Env; runtime?: GoodpointRuntime }): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/") return await readPublic("landing.html");
  if (req.method === "GET" && (path === "/app" || path === "/index.html")) {
    // a viewer loading the UI resumes the runtime (best-effort: the page is served even when
    // the box's env isn't provisioned yet).
    try {
      (ctx?.runtime ?? getRuntime(ctx?.env ?? {})).start();
    } catch { /* missing cfg — still serve the UI */ }
    return await readPublic("index.html");
  }

  let app: GoodpointRuntime;
  try {
    app = ctx?.runtime ?? getRuntime(ctx?.env ?? {});
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }

  if (req.method === "POST" && path === "/start") {
    app.start();
    return json({ ok: true, running: app.running });
  }
  if (req.method === "POST" && path === "/stop") {
    app.stop();
    return json({ ok: true });
  }
  if (req.method === "GET" && path === "/events") {
    // a poller is a viewer — refresh the consumer heartbeat (and resume an idled weave).
    app.resumeConsumer();
    const since = Number(url.searchParams.get("since") || 0);
    const out = app.events.filter((e) => e.seq > since);
    return json({
      seq: out.length ? out[out.length - 1].seq : since,
      events: out.map((e) => e.ev),
      running: app.running,
      weave_running: app.weaveRunning,
      otter_running: app.otterRunning,
    });
  }
  if (req.method === "GET" && path === "/goodpoints") return json({ goodpoints: app.ledger });
  if (req.method === "POST" && path === "/listen") {
    const audio = new Uint8Array(await req.arrayBuffer());
    if (!audio.length) return json({ error: "empty audio" }, 400);
    try {
      const scored = await app.transcribe(audio);
      if (!scored.text || scored.drop) {
        return json({ text: scored.text, confidence: scored.confidence, dropped: true, ingested: false });
      }
      const seg = await app.ingestSpeech(scored.text);
      return json({ text: scored.text, confidence: scored.confidence, dropped: false, ingested: true, order: seg.order });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }
  if (req.method === "GET" && path === "/graph") {
    return json({
      topics: app.graphTopics,
      nodes: app.graphNodes,
      decisions: app.graphNodes.filter((n) => n.kind === "decision" || n.kind === "action_item"),
    });
  }
  if (req.method === "GET" && path === "/diag") {
    return json({
      otter: {
        cursor: app.cursor,
        last_fetch_ok: app.lastFetchOk,
        last_fetch_err: app.lastFetchErr,
        last_fetch_at: app.lastFetchAt,
        segment_count: app.transcript.length,
      },
      ledger_count: app.ledger.length,
      graph: { nodes: app.graphNodes.length, topics: app.graphTopics.length, undecoded: app.decodeQueue.length - app.decodedCount },
      mic_segments: app.micSeq,
      e2ee: {
        toolsmith_model: app.cfg.toolsmithModel,
        compositor_model: app.cfg.compositorModel,
        ready: true,
      },
      idle: {
        enabled: app.enabled,
        weave_running: app.weaveRunning,
        otter_running: app.otterRunning,
        weave_idle_ms: app.cfg.weaveIdleMs,
        otter_idle_ms: app.cfg.otterIdleMs,
        last_consumer_at: app.lastConsumerAt,
        last_live_at: app.lastLiveAt,
        last_weave_idle_at: app.lastWeaveIdleAt,
        last_otter_idle_at: app.lastOtterIdleAt,
        weave_idle_reason: app.weaveIdleReason,
        otter_idle_reason: app.otterIdleReason,
      },
    });
  }
  if (req.method === "POST" && path === "/reset") {
    app.transcript = [];
    app.ledger = [];
    app.seen.clear();
    app.cursor = 0;
    app.brief = { mood: "", emphasis: "", tone: "", direction: "" };
    app.events = [];
    app.seq = 0;
    app.graphNodes = [];
    app.graphTopics = [];
    app.decodeQueue = [];
    app.decodedCount = 0;
    app.micSeq = 0;
    return json({ ok: true });
  }
  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  Deno.serve({ port: Number(Deno.env.get("PORT") || "8080") }, (req) => handler(req, { env: Deno.env.toObject() }));
}
