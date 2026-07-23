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
  maxTools: number;
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

// Hand-built starter toolbox: the compositor has a full palette from second zero instead of
// waiting on the toolsmith's first builds. One per TOOLSMITH_SYSTEM category, same craft rules.
// Starters are protected from eviction (a guaranteed floor) but the toolsmith may still improve
// them in place by reusing the name.
export const STARTER_TOOLS: ToolDef[] = [
  {
    name: "starfield_drift",
    desc: "parallax starfield drifting sideways with twinkle",
    params: [
      { name: "density", default: 140, min: 30, max: 300 },
      { name: "speed", default: 1, min: 0, max: 3 },
      { name: "hue", default: 210, min: 0, max: 360 },
      { name: "size", default: 1.2, min: 0.5, max: 3 },
    ],
    draw: "(ctx,p,t,w,h)=>{const k=Math.max(1,Math.min(w,h)/400);ctx.save();for(let i=0;i<p.density;i++){const s=(i*2654435761%997)/997,r=(i*40503%991)/991,z=0.2+0.8*r;const x=((s*w+t*p.speed*20*z*k)%w+w)%w,y=(r*h+Math.sin(t*0.3+i)*4*k+h)%h;const tw=0.5+0.5*Math.sin(t*2+i*1.7);ctx.fillStyle='hsla('+(p.hue+i%40)+',80%,'+(62+tw*25)+'%,'+(0.3+0.55*z*tw)+')';ctx.beginPath();ctx.arc(x,y,z*(0.6+tw*p.size)*k,0,6.283);ctx.fill();}ctx.restore();}",
  },
  {
    name: "aurora_veil",
    desc: "translucent aurora ribbons swaying over the frame",
    params: [
      { name: "bands", default: 3, min: 1, max: 6 },
      { name: "drift", default: 0.6, min: 0, max: 2 },
      { name: "hue", default: 150, min: 0, max: 360 },
      { name: "glow", default: 1, min: 0.2, max: 2 },
    ],
    draw: "(ctx,p,t,w,h)=>{const k=Math.max(1,Math.min(w,h)/400);ctx.save();ctx.globalCompositeOperation='lighter';ctx.globalAlpha=0.5;for(let b=0;b<p.bands;b++){const g=ctx.createLinearGradient(0,0,0,h),hu=p.hue+b*24;g.addColorStop(0,'hsla('+hu+',85%,55%,0)');g.addColorStop(0.5,'hsla('+hu+',85%,52%,'+(0.16*p.glow)+')');g.addColorStop(1,'hsla('+hu+',85%,55%,0)');ctx.fillStyle=g;ctx.beginPath();ctx.moveTo(0,h);for(let x=0;x<=w;x+=16){const y=h*0.35+b*30*k+Math.sin(x*0.004/k+t*p.drift+b*1.9)*70*k+Math.sin(x*0.011/k-t*0.7)*30*k;ctx.lineTo(x,y);}ctx.lineTo(w,h);ctx.closePath();ctx.fill();}ctx.restore();}",
  },
  {
    name: "wire_icosa",
    desc: "rotating wireframe icosahedron with depth-shaded neon edges",
    params: [
      { name: "spin", default: 0.5, min: 0, max: 2 },
      { name: "size", default: 1, min: 0.4, max: 2 },
      { name: "hue", default: 280, min: 0, max: 360 },
    ],
    draw: "(ctx,p,t,w,h)=>{const PH=1.618,V=[];for(const v of [[0,1,PH],[0,1,-PH],[0,-1,PH],[0,-1,-PH]]){V.push(v,[v[1],v[2],v[0]],[v[2],v[0],v[1]]);}const a=t*p.spin,b=t*p.spin*0.7,f=300,R=Math.min(w,h)*0.22*p.size;const P=V.map(v=>{const x1=v[0]*R*Math.cos(a)-v[2]*R*Math.sin(a),z1=v[0]*R*Math.sin(a)+v[2]*R*Math.cos(a);const y1=v[1]*R*Math.cos(b)-z1*Math.sin(b),z2=v[1]*R*Math.sin(b)+z1*Math.cos(b);const s=f/(f+z2+R*2.2);return [w/2+x1*s,h/2+y1*s,z2/R];});const k=Math.max(1,Math.min(w,h)/400);ctx.save();ctx.lineWidth=1.6*k;ctx.shadowBlur=18*k;ctx.shadowColor='hsl('+p.hue+',90%,60%)';for(let i=0;i<12;i++)for(let j=i+1;j<12;j++){const dx=V[i][0]-V[j][0],dy=V[i][1]-V[j][1],dz=V[i][2]-V[j][2];if(dx*dx+dy*dy+dz*dz<4.2){const dep=(P[i][2]+P[j][2])/6.5;ctx.strokeStyle='hsla('+p.hue+',90%,'+(60-dep*15)+'%,'+(0.8-dep*0.3)+')';ctx.beginPath();ctx.moveTo(P[i][0],P[i][1]);ctx.lineTo(P[j][0],P[j][1]);ctx.stroke();}}ctx.restore();}",
  },
  {
    name: "neon_tunnel",
    desc: "perspective ring tunnel flying forward with a slow weave",
    params: [
      { name: "rings", default: 14, min: 4, max: 30 },
      { name: "speed", default: 1, min: 0, max: 3 },
      { name: "hue", default: 190, min: 0, max: 360 },
      { name: "twist", default: 0.5, min: 0, max: 2 },
    ],
    draw: "(ctx,p,t,w,h)=>{const k=Math.max(1,Math.min(w,h)/400);ctx.save();const f=300,n=Math.floor(p.rings);for(let i=0;i<n;i++){const z=(i/n+t*p.speed*0.12)%1,s=f/((1-z)*900+60),r=Math.min(w,h)*0.9*s;const cx=w/2+Math.sin(t*0.4+z*p.twist*6)*w*0.06,cy=h/2+Math.cos(t*0.3+z*p.twist*6)*h*0.06;ctx.strokeStyle='hsla('+(p.hue+z*60)+',90%,'+(42+z*25)+'%,'+(0.14+z*0.6)+')';ctx.lineWidth=(1+z*3)*k;ctx.shadowBlur=14*k;ctx.shadowColor='hsl('+(p.hue+z*60)+',90%,55%)';ctx.beginPath();for(let k=0;k<=24;k++){const an=k/24*6.283,rr=r*(1+0.08*Math.sin(an*6+t*2));const x=cx+Math.cos(an)*rr,y=cy+Math.sin(an)*rr;k?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.closePath();ctx.stroke();}ctx.restore();}",
  },
  {
    name: "sigil_orbit",
    desc: "glowing star sigils orbiting on a shallow ellipse",
    params: [
      { name: "count", default: 5, min: 1, max: 12 },
      { name: "spin", default: 0.4, min: 0, max: 2 },
      { name: "scale", default: 2, min: 0.5, max: 5 },
      { name: "hue", default: 45, min: 0, max: 360 },
    ],
    draw: "(ctx,p,t,w,h)=>{const path=new Path2D('M12 2 L15 9 L22 9 L16.5 13.5 L18.5 21 L12 16.5 L5.5 21 L7.5 13.5 L2 9 L9 9 Z');const k=Math.max(1,Math.min(w,h)/400);ctx.save();ctx.shadowBlur=22*k;const n=Math.floor(p.count);for(let i=0;i<n;i++){const an=t*p.spin+i/n*6.283,R=Math.min(w,h)*0.32;const x=w/2+Math.cos(an)*R,y=h/2+Math.sin(an)*R*0.6,hu=p.hue+i*20;ctx.save();ctx.translate(x,y);ctx.rotate(an+t*0.8);const s=p.scale*(0.8+0.3*Math.sin(t*1.5+i))*k;ctx.scale(s,s);ctx.translate(-12,-12);ctx.globalAlpha=0.7+0.25*Math.sin(t+i*2.1);ctx.shadowColor='hsl('+hu+',90%,60%)';ctx.strokeStyle='hsla('+hu+',90%,65%,0.95)';ctx.lineWidth=2*k/s;ctx.stroke(path);ctx.restore();}ctx.restore();}",
  },
  {
    name: "caption_wave",
    desc: "live caption as glowing per-letter wave typography",
    params: [
      { name: "size", default: 34, min: 16, max: 72 },
      { name: "wave", default: 8, min: 0, max: 30 },
      { name: "speed", default: 1, min: 0, max: 3 },
      { name: "hue", default: 320, min: 0, max: 360 },
    ],
    draw: "(ctx,p,t,w,h,txt)=>{const s=String(txt||'').slice(0,90);if(!s)return;const k=Math.max(1,Math.min(w,h)/400);ctx.save();let fs=p.size*k;ctx.font='700 '+fs+'px system-ui,sans-serif';const cw=ctx.measureText(s).width;if(cw>w-48){fs=Math.max(12,fs*(w-48)/cw);ctx.font='700 '+fs+'px system-ui,sans-serif';}ctx.textBaseline='middle';let x=(w-ctx.measureText(s).width)/2;const y0=h*0.82;ctx.shadowBlur=16*k;for(let i=0;i<s.length;i++){const y=y0+Math.sin(t*p.speed*2+i*0.35)*p.wave*k,hu=p.hue+i*3;ctx.shadowColor='hsl('+hu+',85%,60%)';ctx.fillStyle='hsla('+hu+',85%,74%,0.95)';ctx.fillText(s[i],x,y);x+=ctx.measureText(s[i]).width;}ctx.restore();}",
  },
];
const STARTER_NAMES = new Set(STARTER_TOOLS.map((t) => t.name));

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
    maxTools: Number(get("MAX_TOOLS")) || 24,
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
    this.seedTools();
  }

  seedTools(): void {
    for (const tool of STARTER_TOOLS) {
      this.registry.set(tool.name, tool);
      this.push({ type: "tool", tool, updated: false });
    }
  }

  // registry doubles as an LRU: composed tools are re-inserted at the tail, so the head is the
  // least recently used. Starters are never evicted (guaranteed palette floor), nor is anything
  // in the composition currently on screen.
  evictTools(): void {
    const inUse = new Set(((this.composition as any).layers ?? []).map((l: any) => l?.tool));
    for (const name of this.registry.keys()) {
      if (this.registry.size <= this.cfg.maxTools) return;
      if (STARTER_NAMES.has(name) || inUse.has(name)) continue;
      this.registry.delete(name);
      this.push({ type: "tool-evicted", name });
    }
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
    this.registry.delete(tool.name);
    this.registry.set(tool.name, tool);
    this.push({ type: "tool", tool, updated });
    this.evictTools();
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
    for (const l of comp.layers) {
      const t = this.registry.get(l.tool)!;
      this.registry.delete(l.tool);
      this.registry.set(l.tool, t);
    }
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
  const img = path.match(/^\/([a-z0-9-]+\.(jpg|png))$/);
  if (req.method === "GET" && img) {
    try {
      const body = await Deno.readFile(new URL(`./public/${img[1]}`, import.meta.url));
      return new Response(body, { headers: { "content-type": img[2] === "jpg" ? "image/jpeg" : "image/png", "cache-control": "public, max-age=300" } });
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return new Response("not found", { status: 404 });
      throw e;
    }
  }
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
  // full palette snapshot: a fresh viewer must not depend on tool events still being in the
  // (500-capped) events buffer.
  if (req.method === "GET" && path === "/tools") return json({ tools: [...app.registry.values()] });
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
      tools: { count: app.registry.size, max: app.cfg.maxTools },
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
    app.registry.clear();
    app.composition = { layers: [] };
    app.seedTools();
    return json({ ok: true });
  }
  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  Deno.serve({ port: Number(Deno.env.get("PORT") || "8080") }, (req) => handler(req, { env: Deno.env.toObject() }));
}
