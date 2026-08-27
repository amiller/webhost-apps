import vm from "node:vm";
import { gzipSync, gunzipSync } from "node:zlib";
import { attestation, nearStream } from "./near_e2ee.ts";
import { chutesStream } from "./chutes_e2ee.ts";
import { hostedStream } from "./hosted_stream.ts";

type Env = Record<string, string | undefined>;

interface Cfg {
  oauth3Core: string;
  otterToken: string;
  nearKey: string;
  attestPins: Record<string, string>;
  chutesKey: string;
  toolsmithModel: string;
  compositorModel: string;
  // #94 privacy cleave: HEARING lanes (judge/distill/decoder/state/convtype) consume the verbatim
  // transcript, so each has its OWN e2ee model — they never inherit a possibly-hosted
  // TOOLSMITH/COMPOSITOR model. Paint lanes (toolsmith/compositor/critic) see only sanitized
  // input and MAY optionally route to a plaintext hosted endpoint when BASE_URL is set.
  judgeModel: string;
  distillModel: string;
  decoderModel: string;
  stateModel: string;
  toolsmithBaseUrl: string;
  toolsmithApiKey: string;
  compositorBaseUrl: string;
  compositorApiKey: string;
  weaveIdleMs: number;
  otterIdleMs: number;
  sttBase: string;
  sttModel: string;
  maxTools: number;
  // #130 durable archive cadence + caps.
  traceKeep: number; // max local rotating-buffer trace files (open session never pruned)
  seedLibraryCount: number; // cap on tools reseeded from the library at boot
  archiveFlushMs: number; // supervisor-driven flush cadence
  // #92 optional compositor-class critic (default off).
  criticModel: string;
  enableCritic: boolean;
  // #126: per-call stream deadlines (ms). Generous per call site — a stalled stream aborts and
  // surfaces a lane-named status instead of wedging the lane forever. Env-tunable (*_TIMEOUT_MS).
  toolsmithTimeoutMs: number;
  compositorTimeoutMs: number;
  distillTimeoutMs: number;
  decoderTimeoutMs: number;
  judgeTimeoutMs: number;
  // #126 (rebase extension): state/convtype hearing reads (#85/#88) get the same discipline —
  // they run in the otter loop, so a hung read wedges the loop / skips sibling lanes.
  stateTimeoutMs: number;
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

// Conversation-type readout (#88). Classifies the current stretch of meeting into one of
// a small set of genres, with a one-line rationale. Shares the judge loop / e2ee path and
// the otter-loop hook (no new timer); kept standalone + namespaced so it composes with #83's
// ConversationState (recap/shift/flow) without collision.
export const CONVERSATION_TYPES = [
  "decision-making",
  "brainstorming",
  "status-update",
  "debate",
  "social",
] as const;
export type ConversationTypeKind = (typeof CONVERSATION_TYPES)[number];
export interface ConversationType {
  type: string;
  rationale: string;
}

// #83 conversation-state readouts: a rolling recap, topic-shift markers, and audience/purpose/register
// estimates, produced by the SAME judge-loop machinery (strict-JSON verdicts over a transcript window).
export interface RecapResult {
  recap: string;
}

export interface ShiftResult {
  shifted: boolean;
  topic: string;
}

export type ConversationalRegister = "casual" | "working" | "formal";

export interface FlowEstimate {
  audience: string;
  purpose: string;
  register: ConversationalRegister | string;
}

export interface ConversationState {
  recap: string;
  shifts: { t: number; topic: string }[];
  estimate: FlowEstimate;
  last_topic: string;
}

export type StateKind = "recap" | "shift" | "flow";

/** Optional model-stream injection (tests): when set, `streamComplete` calls this instead of
 *  the real NEAR/Chutes/hosted paths, so loops can be exercised with no network egress. */
export interface StreamProvider {
  complete(
    lane: Lane,
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
const DISTILL_SYSTEM = `From a live-room transcript (may have fragments/mis-hears), design a VISUAL BRIEF. First pick the few highlights that actually matter (the key phrases, the turn of the discussion) and read the tone (emotional register + energy). Then translate that into a concrete plan for abstract visuals. Output STRICT JSON: {"mood":"one evocative line (<=14 words) to steer visuals by","emphasis":"a STRUCTURAL descriptor of the single most important phrase — word count and sentence register only (e.g. '6-word question'), NEVER the words themselves","tone":"emotional register + energy (<=8 words, e.g. 'hushed, reflective' or 'rising, electric')","direction":"a thoughtful effect plan grounded in the highlights + tone: what should move, how, what to emphasize (<=24 words)"}. Ignore filler and noise. PRIVACY: every field must be your own original phrasing — never copy transcript words verbatim (#94: this brief feeds models that must not read the room).`;

const JUDGE_SYSTEM = `You judge a live meeting transcript for genuinely useful "good points".
Return STRICT JSON only:
{"good_point":bool,"quote":"<=140 chars near-verbatim","why":"<=12 words","score":0-10}
Flag only concise, reusable insights, decisions, or unusually clear framing. Ignore filler, logistics, and vague agreement.`;

// #83: the three conversation-state verdicts, same strict-JSON discipline as the good-point judge.
const RECAP_SYSTEM = `Summarize what the live meeting is currently about in one present-tense sentence (<=24 words).
Return STRICT JSON only:
{"recap":"<=24 words"}`;

const SHIFT_SYSTEM = `You watch a live meeting transcript for topic changes. Given the prior focus and the newest stretch, decide whether the topic has shifted, and name the current topic.
Return STRICT JSON only:
{"shifted":bool,"topic":"<=8 words naming the current topic"}`;

const FLOW_SYSTEM = `Estimate the conversational register of this live meeting stretch.
Return STRICT JSON only:
{"audience":"<=6 words","purpose":"<=6 words","register":"one of: casual | working | formal"}`;

// #88: classify the current stretch into one genre with a one-line rationale.
const TYPE_SYSTEM = `You classify the current stretch of a live meeting into exactly one genre.
Return STRICT JSON only:
{"type":"one of: decision-making | brainstorming | status-update | debate | social","rationale":"<=14 words why"}
Use the genre that best fits the dominant activity in this stretch.`;

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

// #125: canvas snapshot gallery. The box paints client-side and nothing was ever captured; the
// client POSTs jpegs here (on goodpoints + a 60s interval while the weave runs) and they are
// stored under snapshots/<session>/ NEXT TO the traces dir (#124), reusing #124's writable-cwd
// discovery — the dev-mode app cwd is writable (confirmed on staging), so we write straight to
// cwd; an unwritable cwd records writeOk=false and surfaces fs errors as a `status` event, never
// faked in memory. The session id mirrors #124's trace id format so a gallery can correlate the
// two later.
export const SNAP_MAX_BYTES = 2 * 1024 * 1024; // POST /snapshot rejects bodies larger than 2MB (issue #125)
export const SNAP_CAP_FILES = 200; // per-session cap; oldest evicted first, announced by a status event

export interface SnapshotRef {
  session: string;
  file: string;
  t: number;
  bytes: number;
}

/** Filesystem-safe session id, format `2026-07-24T13-00-34-207Z-8c4b8d8a` (ISO with `:`/`.` -> `-`,
 *  + 8 random hex). Same shape as #124's trace session id. */
export function newSessionId(d = new Date()): string {
  const iso = d.toISOString().replace(/[:.]/g, "-");
  const sfx = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${iso}-${sfx}`;
}

export class SnapshotStore {
  readonly dir: string;
  writeOk = true;
  lastErr = "";
  written = 0; // successful stores this process (for /diag)
  private seq = 0;

  constructor(dir: string) {
    this.dir = dir;
  }

  // single path segment only — blocks traversal (`..`, separators, empties)
  private safeSeg(name: string): boolean {
    return !!name && /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";
  }

  /** Store one jpeg under <dir>/<session>/. Returns {ref, evicted, err}; ref is null on failure. */
  async store(session: string, bytes: Uint8Array): Promise<{ ref: SnapshotRef | null; evicted: string[]; err: string }> {
    if (!this.safeSeg(session)) return { ref: null, evicted: [], err: "bad session id" };
    const sdir = `${this.dir}/${session}`;
    try {
      await Deno.mkdir(sdir, { recursive: true });
      const iso = new Date().toISOString().replace(/[:.]/g, "-");
      const file = `${iso}-${String(++this.seq).padStart(4, "0")}.jpg`;
      await Deno.writeFile(`${sdir}/${file}`, bytes);
      const evicted = await this.enforceCap(sdir);
      this.written++;
      this.writeOk = true;
      this.lastErr = "";
      return { ref: { session, file, t: Date.now(), bytes: bytes.length }, evicted, err: "" };
    } catch (e) {
      this.writeOk = false;
      this.lastErr = e instanceof Error ? e.message : String(e);
      return { ref: null, evicted: [], err: this.lastErr };
    }
  }

  // keep the session dir at SNAP_CAP_FILES; evict oldest by mtime. Returns the removed filenames.
  private async enforceCap(sdir: string): Promise<string[]> {
    const ents: { name: string; t: number }[] = [];
    for await (const e of Deno.readDir(sdir)) {
      if (!e.isFile || !e.name.endsWith(".jpg")) continue;
      try {
        const st = await Deno.stat(`${sdir}/${e.name}`);
        ents.push({ name: e.name, t: st.mtime?.getTime() ?? 0 });
      } catch { /* raced — skip */ }
    }
    if (ents.length <= SNAP_CAP_FILES) return [];
    ents.sort((a, b) => a.t - b.t);
    const removed: string[] = [];
    while (ents.length > SNAP_CAP_FILES) {
      const old = ents.shift()!;
      try { await Deno.remove(`${sdir}/${old.name}`); removed.push(old.name); } catch { /* raced */ }
    }
    return removed;
  }

  /** List every snapshot across sessions, oldest first. Returns [] when nothing is stored yet. */
  async list(): Promise<SnapshotRef[]> {
    const out: SnapshotRef[] = [];
    try {
      for await (const session of Deno.readDir(this.dir)) {
        if (!session.isDirectory || !this.safeSeg(session.name)) continue;
        const sdir = `${this.dir}/${session.name}`;
        for await (const e of Deno.readDir(sdir)) {
          if (!e.isFile || !e.name.endsWith(".jpg") || !this.safeSeg(e.name)) continue;
          try {
            const st = await Deno.stat(`${sdir}/${e.name}`);
            out.push({ session: session.name, file: e.name, t: st.mtime?.getTime() ?? 0, bytes: st.size });
          } catch { /* raced */ }
        }
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) this.lastErr = e instanceof Error ? e.message : String(e);
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /** Read one jpeg's bytes; null if missing or the name is unsafe. */
  async read(session: string, file: string): Promise<Uint8Array | null> {
    if (!this.safeSeg(session) || !this.safeSeg(file) || !file.endsWith(".jpg")) return null;
    try {
      return await Deno.readFile(`${this.dir}/${session}/${file}`);
    } catch {
      return null;
    }
  }
}

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

// --- #94 privacy cleave: lanes, routing, and the sanitized brief -----------------------------

/** A lane is WHO is calling inference, not which model. Hearing lanes (judge, distill, decoder,
 *  state, convtype) consume the verbatim transcript and are e2ee BY CONSTRUCTION — `route()` gives
 *  them no hosted branch at all. Paint lanes (toolsmith, compositor, critic) see only sanitized
 *  input (a scrubbed brief / composition signatures) and may route to a plaintext hosted endpoint
 *  when configured. This is the operator's boundary ruling from #94: "models that HEAR THE ROOM
 *  (judge, any transcript→brief distillation incl. #93's) stay on e2ee confidential inference.
 *  Models that only do AESTHETICS may run on any fast hosted model — IF the brief they receive is
 *  sanitized." */
export type Lane = "judge" | "distill" | "decoder" | "state" | "convtype" | "critic" | "toolsmith" | "compositor";

/** Lanes that see verbatim room text. Everything else is the paint crew. */
export const HEARING_LANES: readonly Lane[] = ["judge", "distill", "decoder", "state", "convtype"];

export interface Route {
  lane: Lane;
  model: string;
  transport: "hosted" | "near-e2ee" | "chutes-e2ee";
  baseUrl?: string;
  apiKey?: string;
}

/** The sanitized brief the paint crew (toolsmith/compositor) is allowed to see. Every field is an
 *  abstract descriptor — mood label, tone/energy, a STRUCTURAL emphasis descriptor (word-count +
 *  register), and a motion direction. The verbatim quote and the judge's free-text `why` are
 *  deliberately ABSENT: they flow to the client alone (SSE `goodpoint.point`) for local canvas
 *  text, so no LLM downstream of the judge can read the room's words. (#94) */
export interface Brief {
  mood: string;
  emphasis: string;
  tone: string;
  direction: string;
  avoid?: string[];
}

/** Word 3-grams of a text, lowercased — the verbatim-overlap unit the #94 acceptance uses. */
export function trigramsOf(s: string): Set<string> {
  const words = s.toLowerCase().replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const g = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) g.add(words.slice(i, i + 3).join(" "));
  return g;
}

/** True if `field` carries any 3-gram of `transcript` (a verbatim run of room words). */
export function leaksVerbatim(field: string, transcript: string): boolean {
  const f = field.toLowerCase();
  for (const g of trigramsOf(transcript)) {
    if (f.includes(g)) return true;
  }
  return false;
}

/** Structural description of a phrase: word count + sentence register — NEVER the words. */
export function describePhrase(p: string): string {
  const q = p.trim();
  const words = q.split(/\s+/).filter(Boolean);
  const register = q.endsWith("?") ? "question" : q.endsWith("!") ? "exclamatory" : "declarative";
  return `${words.length}-word ${register}`;
}

/** Banger path: the brief built from a judged point. All fields are constants or structural
 *  descriptors — no verbatim quote, no judge `why`. */
export function sanitizeBrief(point: GoodPoint): Brief {
  const tone = point.score >= 9 ? "triumphant" : point.score >= 8 ? "bright" : "warm";
  return {
    mood: "good point",
    emphasis: describePhrase(point.quote),
    tone,
    direction: "make the good point legible; surge motion to emphasize the insight",
  };
}

/** Distill path (#93 output, #94 bound): the distill lane ran E2EE and read the transcript, but
 *  its OUTPUT brief must still carry no verbatim room words downstream — the operator's ruling:
 *  "its output brief must contain no verbatim n-grams beyond the emphasis descriptor." Emphasis is
 *  ALWAYS replaced by a structural descriptor of the key phrase; mood/tone/direction are the
 *  model's own paraphrase and are kept UNLESS they trip the transcript 3-gram check, in which case
 *  the field is blanked (an absent field reads "—" on the client — honest, never masked) and its
 *  name is reported so the scrub is visible in the event stream. */
export function sanitizeDistilled(
  j: { mood?: unknown; emphasis?: unknown; tone?: unknown; direction?: unknown },
  transcript: string,
): { brief: Brief; scrubbed: string[] } {
  const scrubbed: string[] = [];
  const keep = (name: string, v: string): string => {
    const s = v.replace(/\s+/g, " ").trim();
    if (s && leaksVerbatim(s, transcript)) {
      scrubbed.push(name);
      return "";
    }
    return s;
  };
  return {
    brief: {
      mood: keep("mood", String(j.mood ?? "")),
      emphasis: describePhrase(String(j.emphasis ?? "")),
      tone: keep("tone", String(j.tone ?? "")),
      direction: keep("direction", String(j.direction ?? "")),
    },
    scrubbed,
  };
}

// #88: parse the conversation-type verdict. Defensively clamps both fields; lowercases the type.
// An unknown type is kept verbatim (honest) rather than forced into the enum — the enum is the
// target vocabulary, not a mask. Returns null only on non-JSON or a missing type.
export function parseConvType(raw: string): ConversationType | null {
  const j = extractJson(raw) as Partial<ConversationType> | null;
  if (!j || typeof j !== "object") return null;
  const type = String(j.type ?? "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40);
  if (!type) return null;
  const rationale = String(j.rationale ?? "")
    .replace(/\s+/g, " ").trim().split(/\s+/).slice(0, 14).join(" ").slice(0, 160).trim();
  return { type, rationale };
}

// #83: sanitize + clamp the conversation-state verdicts. Empty/junk -> null (rendered as the quiet
// empty line, never a fabricated value). An unknown register is kept verbatim, not silently coerced.
const clampWords = (s: unknown, n: number, maxChars: number): string =>
  String(s ?? "").replace(/\s+/g, " ").trim().split(/\s+/).slice(0, n).join(" ").slice(0, maxChars).trim();

export function parseRecap(raw: string): RecapResult | null {
  const j = extractJson(raw) as Partial<RecapResult> | null;
  if (!j || typeof j !== "object") return null;
  const recap = clampWords(j.recap, 24, 200);
  return recap ? { recap } : null;
}

export function parseShift(raw: string): ShiftResult | null {
  const j = extractJson(raw) as Partial<ShiftResult> | null;
  if (!j || typeof j !== "object") return null;
  const topic = clampWords(j.topic, 8, 120);
  if (!topic) return null;
  return { shifted: j.shifted === true, topic };
}

const REGISTERS: ConversationalRegister[] = ["casual", "working", "formal"];

export function parseFlow(raw: string): FlowEstimate | null {
  const j = extractJson(raw) as Partial<FlowEstimate> | null;
  if (!j || typeof j !== "object") return null;
  const audience = clampWords(j.audience, 6, 80);
  const purpose = clampWords(j.purpose, 6, 80);
  const r = String(j.register ?? "").toLowerCase().trim();
  const register: ConversationalRegister | string = REGISTERS.includes(r as ConversationalRegister)
    ? (r as ConversationalRegister)
    : (r || "working");
  if (!audience && !purpose) return null;
  return { audience, purpose, register };
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
    attestPins: Object.fromEntries(
      ["NEAR_WORKLOAD_IDS", "NEAR_IMAGE_DIGESTS", "NEAR_KMS_ROOTS", "NEAR_BASE_MEASUREMENTS"]
        .map((k) => [k, get(k)]).filter(([, v]) => v)),
    chutesKey: get("CHUTES_API_KEY"),
    toolsmithModel: get("TOOLSMITH_MODEL") || "deepseek-ai/DeepSeek-V4-Flash",
    compositorModel: get("COMPOSITOR_MODEL") || "unsloth/Mistral-Nemo-Instruct-2407-TEE",
    // #94 hearing-lane models: defaults preserve pre-cleave behavior (judge/decoder/state/convtype
    // rode the toolsmith default, distill rode the compositor default) but they no longer INHERIT
    // TOOLSMITH/COMPOSITOR_MODEL — those may point at hosted models now.
    judgeModel: get("JUDGE_MODEL") || "deepseek-ai/DeepSeek-V4-Flash",
    distillModel: get("DISTILL_MODEL") || "unsloth/Mistral-Nemo-Instruct-2407-TEE",
    decoderModel: get("DECODER_MODEL") || "deepseek-ai/DeepSeek-V4-Flash",
    stateModel: get("STATE_MODEL") || "deepseek-ai/DeepSeek-V4-Flash",
    toolsmithBaseUrl: get("TOOLSMITH_BASE_URL"),
    toolsmithApiKey: get("TOOLSMITH_API_KEY"),
    compositorBaseUrl: get("COMPOSITOR_BASE_URL"),
    compositorApiKey: get("COMPOSITOR_API_KEY"),
    weaveIdleMs: Number(get("WEAVE_IDLE_MS")) || 3 * 60_000,
    otterIdleMs: Number(get("OTTER_IDLE_MS")) || 10 * 60_000,
    sttBase: (get("TRANSCRIBE_BASE_URL") || get("NEAR_BASE") || "https://cloud-api.near.ai/v1").replace(/\/+$/, ""),
    sttModel: get("TRANSCRIBE_MODEL") || "openai/whisper-large-v3",
    maxTools: Number(get("MAX_TOOLS")) || 24,
    traceKeep: Number(get("TRACE_KEEP")) || 20,
    seedLibraryCount: Number(get("SEED_LIBRARY_COUNT")) || 6,
    archiveFlushMs: Number(get("ARCHIVE_FLUSH_MS")) || 60_000,
    criticModel: get("CRITIC_MODEL") || get("COMPOSITOR_MODEL") || "unsloth/Mistral-Nemo-Instruct-2407-TEE",
    enableCritic: /^(1|true|yes)$/i.test(get("ENABLE_CRITIC") || ""),
    toolsmithTimeoutMs: Number(get("TOOLSMITH_TIMEOUT_MS")) || 60_000,
    compositorTimeoutMs: Number(get("COMPOSITOR_TIMEOUT_MS")) || 30_000,
    distillTimeoutMs: Number(get("DISTILL_TIMEOUT_MS")) || 30_000,
    decoderTimeoutMs: Number(get("DECODER_TIMEOUT_MS")) || 30_000,
    judgeTimeoutMs: Number(get("JUDGE_TIMEOUT_MS")) || 30_000,
    stateTimeoutMs: Number(get("STATE_TIMEOUT_MS")) || 30_000,
  };
  const missing = [
    ["OAUTH3_CORE", cfg.oauth3Core],
    ["OTTER_TOKEN", cfg.otterToken],
    ["NEAR_API_KEY", cfg.nearKey],
    ["NEAR_KMS_ROOTS", cfg.attestPins.NEAR_KMS_ROOTS],
    ["NEAR_BASE_MEASUREMENTS", cfg.attestPins.NEAR_BASE_MEASUREMENTS],
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

// --- session trace persistence (#124) ---------------------------------------------
// Every pushed event is appended as one JSON line to a per-session file under the app's working
// directory (`traces/<session-start-iso>.jsonl`). A session starts at process boot (= first
// runtime construction — the runtime is lazy) and at each POST /reset. fs errors are recorded on
// the store (`writeOk=false`, surfaced via /diag) and emitted as ONE `status` event — never
// silently swallowed, never faked with an in-memory buffer. Persistence is off only when
// explicitly disabled (`traceStore=null`); production defaults to `traces/` (or `env.TRACE_DIR`).
export interface TraceEntry {
  id: string; // fs-safe session-start ISO (the filename stem)
  started: string; // real session-start ISO
  bytes: number;
  events: number;
}

function emsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class TraceStore {
  readonly dir: string;
  id = "";
  started = "";
  bytes = 0;
  events = 0;
  writeOk = false;
  lastErr = "";
  private fh: Deno.FsFile | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  // Close any open handle and open a fresh session file (boot + /reset). On fs failure the store
  // records writeOk=false; it never throws — callers learn the outcome via append()/diag.
  rotate(): void {
    try {
      this.fh?.close();
    } catch { /* best effort */ }
    this.fh = null;
    this.started = new Date().toISOString();
    // id = fs-safe ISO + short random suffix so two sessions starting in the same millisecond
    // (e.g. boot + an immediate /reset) never collide on the filename.
    this.id = this.started.replace(/[:.]/g, "-") + "-" + crypto.randomUUID().slice(0, 8);
    this.bytes = 0;
    this.events = 0;
    try {
      Deno.mkdirSync(this.dir, { recursive: true });
      this.fh = Deno.openSync(`${this.dir}/${this.id}.jsonl`, { create: true, append: true });
      this.writeOk = true;
      this.lastErr = "";
    } catch (e) {
      this.fh = null;
      this.writeOk = false;
      this.lastErr = emsg(e);
    }
  }

  // Append one JSON line. Returns null on success, an error message on failure (never throws).
  append(line: string): string | null {
    if (!this.fh) return this.lastErr || "trace not open";
    try {
      const buf = new TextEncoder().encode(line + "\n");
      this.fh.writeSync(buf);
      this.bytes += buf.byteLength;
      this.events += 1;
      this.writeOk = true;
      this.lastErr = "";
      return null;
    } catch (e) {
      this.writeOk = false;
      this.lastErr = emsg(e);
      return this.lastErr;
    }
  }

  // Snapshot of every `*.jsonl` trace on disk, newest first. `bytes`/`events` are read from the
  // file so they stay correct after a restart (the in-memory counters only cover this session).
  list(): TraceEntry[] {
    const out: TraceEntry[] = [];
    try {
      for (const e of Deno.readDirSync(this.dir)) {
        if (!e.isFile || !e.name.endsWith(".jsonl")) continue;
        const id = e.name.slice(0, -".jsonl".length);
        out.push({
          id,
          started: startedFromId(id),
          bytes: sizeOf(`${this.dir}/${e.name}`),
          events: countLines(`${this.dir}/${e.name}`),
        });
      }
    } catch { /* dir missing → empty list */ }
    return out.sort((a, b) => (a.started < b.started ? 1 : -1));
  }

  // Open a trace for streaming back. Returns null if not found / unsafe id (no path traversal).
  openRead(id: string): Deno.FsFile | null {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    try {
      return Deno.openSync(`${this.dir}/${id}.jsonl`, { read: true });
    } catch {
      return null;
    }
  }
}

// Reconstruct the real ISO from an fs-safe id, ignoring any uniqueness suffix.
// `2026-07-24T19-30-45-123Z-1a2b3c4d` → `2026-07-24T19:30:45.123Z`.
function startedFromId(id: string): string {
  const m = id.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-[0-9a-f]+)?$/);
  if (!m) return id;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
}

function sizeOf(path: string): number {
  try {
    return Deno.statSync(path).size ?? 0;
  } catch {
    return 0;
  }
}

function countLines(path: string): number {
  try {
    const txt = Deno.readTextFileSync(path);
    if (!txt) return 0;
    let n = 0;
    for (let i = 0; i < txt.length; i++) if (txt.charCodeAt(i) === 10) n++;
    return n;
  } catch {
    return 0;
  }
}

// --- durable external archive (#130) ---------------------------------------------
// Off-pod sink for the local traces (#124) + snapshots (#125, when it lands) and the reusable
// tool library. The backend is selectable via env (`ARCHIVE_BACKEND`, default `local`) and points
// at an external volume / bucket via `ARCHIVE_DIR` — never baked in, no creds in source. The
// reference `LocalArchiveBackend` writes a content-addressed layout (tools/<sha256-of-draw>.json,
// blobs/<hash>, traces/<id>.jsonl.gz) so re-generated identical tools dedup by hash and snapshots
// dedup by content; traces are gzipped on flush. No fallback: a backend failure surfaces as one
// `status` event and sets last_err; the runtime never pretends persistence succeeded.
export interface ArchiveToolRecord {
  name: string;
  desc: string;
  params: ToolDef["params"];
  draw: string;
  session: string; // session id (trace stem) that produced it
  ts: number;
  hash: string; // sha256(draw) — the content-address key + dedup identity
}

export interface ArchiveTraceEntry {
  id: string;
  bytes: number; // compressed bytes held in the archive
}

export interface ArchiveBackend {
  readonly name: string;
  // tool library, content-addressed by hash of the draw body (identical bodies dedup to one entry)
  putTool(rec: ArchiveToolRecord): Promise<string | null>; // null = ok, string = error message
  listTools(): Promise<ArchiveToolRecord[]>; // one record per unique hash, newest ts first
  // content-addressed blobs — #125 snapshots flush through here when that issue merges
  putBlob(hash: string, bytes: Uint8Array): Promise<string | null>;
  hasBlob(hash: string): Promise<boolean>;
  // gzipped session traces
  putTrace(id: string, gz: Uint8Array): Promise<string | null>;
  listTraces(): Promise<ArchiveTraceEntry[]>;
  readTrace(id: string): Promise<Uint8Array | null>; // gzipped bytes, or null if absent / unsafe id
}

export async function toolHash(draw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(draw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Reference backend: a directory (env ARCHIVE_DIR). Treat that dir as an external volume — on a
// persistent mount it IS the durable copy; the pod's traces/ dir is the rotating buffer flushed-
// then-pruned against it. An S3-compatible backend implements the same interface and is selected
// by ARCHIVE_BACKEND=s3 once added; the contract here is the stable surface.
export class LocalArchiveBackend implements ArchiveBackend {
  readonly name = "local";
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private ensure(): void {
    Deno.mkdirSync(`${this.dir}/tools`, { recursive: true });
    Deno.mkdirSync(`${this.dir}/blobs`, { recursive: true });
    Deno.mkdirSync(`${this.dir}/traces`, { recursive: true });
  }
  async putTool(rec: ArchiveToolRecord): Promise<string | null> {
    try {
      this.ensure();
      await Deno.writeTextFile(`${this.dir}/tools/${rec.hash}.json`, JSON.stringify(rec));
      return null;
    } catch (e) {
      return emsg(e);
    }
  }
  async listTools(): Promise<ArchiveToolRecord[]> {
    const out: ArchiveToolRecord[] = [];
    try {
      for (const e of Deno.readDirSync(`${this.dir}/tools`)) {
        if (!e.isFile || !e.name.endsWith(".json")) continue;
        try {
          const rec = JSON.parse(await Deno.readTextFile(`${this.dir}/tools/${e.name}`)) as ArchiveToolRecord;
          if (rec && typeof rec.draw === "string" && typeof rec.hash === "string") out.push(rec);
        } catch { /* corrupt entry — skip, never crash a list */ }
      }
    } catch { /* dir missing → empty list */ }
    return out.sort((a, b) => b.ts - a.ts); // one per hash (filename is the hash), newest ts first
  }
  async putBlob(hash: string, bytes: Uint8Array): Promise<string | null> {
    if (!/^[0-9a-f]{8,}$/.test(hash)) return "invalid hash";
    try {
      this.ensure();
      const p = `${this.dir}/blobs/${hash}`;
      try {
        if ((await Deno.stat(p)).isFile) return null; // content-addressed → already present
      } catch { /* not present — fall through to write */ }
      await Deno.writeFile(p, bytes);
      return null;
    } catch (e) {
      return emsg(e);
    }
  }
  async hasBlob(hash: string): Promise<boolean> {
    if (!/^[0-9a-f]{8,}$/.test(hash)) return false;
    try {
      await Deno.stat(`${this.dir}/blobs/${hash}`);
      return true;
    } catch {
      return false;
    }
  }
  async putTrace(id: string, gz: Uint8Array): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return "invalid id";
    try {
      this.ensure();
      await Deno.writeFile(`${this.dir}/traces/${id}.jsonl.gz`, gz);
      return null;
    } catch (e) {
      return emsg(e);
    }
  }
  async listTraces(): Promise<ArchiveTraceEntry[]> {
    const out: ArchiveTraceEntry[] = [];
    try {
      for (const e of Deno.readDirSync(`${this.dir}/traces`)) {
        if (!e.isFile || !e.name.endsWith(".jsonl.gz")) continue;
        out.push({ id: e.name.slice(0, -".jsonl.gz".length), bytes: sizeOf(`${this.dir}/traces/${e.name}`) });
      }
    } catch { /* dir missing → empty */ }
    return out;
  }
  async readTrace(id: string): Promise<Uint8Array | null> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    try {
      return await Deno.readFile(`${this.dir}/traces/${id}.jsonl.gz`);
    } catch {
      return null;
    }
  }
}

// Build the archive from env. Opt-in: nothing is baked in, and the operator mounts the volume /
// provides creds via env. Returns null (archive disabled, surfaced honestly as backend:"none" in
// /diag) unless ARCHIVE_DIR names a writable target and ARCHIVE_BACKEND isn't "none". Only the
// `local` reference backend ships here; an unimplemented selection (s3, …) disables rather than
// silently pretending to persist.
export function buildArchive(env: Env): ArchiveBackend | null {
  const backend = (env.ARCHIVE_BACKEND ?? "").toLowerCase();
  if (["none", "off", "disabled"].includes(backend)) return null;
  if (backend && backend !== "local") return null; // not yet implemented — disabled, not a fake
  const dir = env.ARCHIVE_DIR ?? "";
  if (!dir) return null; // opt-in via ARCHIVE_DIR (an external volume mount)
  return new LocalArchiveBackend(dir);
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
  // #88 conversation-type readout (decision-making / brainstorming / status-update / debate / social).
  lastConvTypeAt = 0;
  convType: ConversationType = { type: "", rationale: "" };
  // #83 conversation-state readouts (recap / topic shifts / audience-purpose-register).
  lastStateAt = 0;
  recap = "";
  shifts: { t: number; topic: string }[] = [];
  lastTopic = "";
  estimate: FlowEstimate = { audience: "", purpose: "", register: "" };
  // #126: per-lane last_turn_at (ms) exposed via /diag so a wedged lane is visible remotely.
  lastToolsmithTurnAt = 0;
  lastCompositorTurnAt = 0;
  registry = new Map<string, ToolDef>();
  composition: unknown = { layers: [] };
  // #92 real-time self-eval: detect visual staleness and self-regulate. Cheap (no LLM) quantized
  // signature per composition; a rolling window flags a stuck compositor; selfNudge escalates.
  readonly STALE_WINDOW = 10; // rolling compositions considered
  readonly STALE_THRESHOLD = 8; // identical sigs in-window => stuck => self-nudge
  readonly CRITIC_EVERY = 10; // optional critic fires every N compositions
  recentSigs: string[] = [];
  staleness = 0;
  compositionCount = 0;
  nudgeCount = 0;
  lastNudgeAt = 0;
  lastNudgeAction = "";
  toolUseCount = new Map<string, number>();
  brief: Brief = { mood: "", emphasis: "", tone: "", direction: "" };
  events: { seq: number; ev: unknown }[] = [];
  seq = 0;
  // #124: per-session JSONL trace of every pushed event. null only when explicitly disabled.
  traces: TraceStore | null;
  // #130: durable external archive (traces + tool library). null only when explicitly disabled
  // (no ARCHIVE_DIR) — surfaced honestly as backend:"none" in /diag.
  archive: ArchiveBackend | null;
  archiveFlushed = 0; // cumulative sessions written to the archive this process
  archiveLastOk = 0; // ts of the last fully-successful flush
  archiveLastErr = "";
  private lastArchiveFlushAt = 0;
  bootSeedPromise: Promise<void> = Promise.resolve();
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
  // #83: optional in-process state-verdict provider (tests / harness), mirrors judgeOverride.
  private stateOverride?: (kind: StateKind, text: string) => Promise<string | null>;
  // #88: optional conversation-type provider (tests / harness), mirrors judgeOverride.
  private typeOverride?: (text: string) => Promise<ConversationType | null>;
  private streams?: StreamProvider;
  // #92: optional compositor-class critic provider (tests / harness), mirrors the other overrides.
  private criticOverride?: (sigs: string[]) => Promise<string>;
  // #125: snapshot session + store. sessionId is the single source of truth for "the current
  // session" (boot + /reset); the snapshot dir groups jpegs under it. When #124's traces land they
  // should adopt this same runtime sessionId so snapshots <-> traces correlate.
  sessionId: string;
  snapshots: SnapshotStore;

  constructor(
    env: Env,
    judgeOverride?: (text: string) => Promise<JudgeResult | null>,
    streams?: StreamProvider,
    traceStore?: TraceStore | null,
    stateOverride?: (kind: StateKind, text: string) => Promise<string | null>,
    typeOverride?: (text: string) => Promise<ConversationType | null>,
    archive?: ArchiveBackend | null,
    criticOverride?: (sigs: string[]) => Promise<string>,
  ) {
    this.cfg = requireCfg(env);
    this.judgeOverride = judgeOverride;
    this.stateOverride = stateOverride;
    this.typeOverride = typeOverride;
    this.streams = streams;
    this.criticOverride = criticOverride;
    // #124: persistence is on by default (writes traces/ under the cwd); pass null to disable.
    this.traces = traceStore === undefined ? new TraceStore(env.TRACE_DIR || "traces") : traceStore;
    // #130: durable archive — opt-in via ARCHIVE_DIR (external volume); pass null to disable.
    this.archive = archive === undefined ? buildArchive(env) : archive;
    this.traces?.rotate(); // open the boot-session file (rotates again on /reset)
    this.sessionId = newSessionId();
    this.snapshots = new SnapshotStore(env.SNAPSHOT_DIR || "snapshots");
    this.seedTools();
    // #130: reseed the registry from the durable tool library when gated on, so a good tool from
    // one session is available in the next (survives a redeploy). Fire-and-forget at boot.
    if (this.archive && (env.SEED_FROM_LIBRARY ?? "").toLowerCase() === "true") {
      this.bootSeedPromise = this.seedFromLibrary()
        .then((_n) => {})
        .catch((e) => this.push({ type: "status", text: `library seed failed: ${emsg(e)}` }));
    }
  }

  seedTools(): void {
    for (const tool of STARTER_TOOLS) {
      this.registry.set(tool.name, tool);
      this.push({ type: "tool", tool, updated: false });
    }
  }

  // registry doubles as an LRU: composed tools are re-inserted at the tail, so the head is the
  // least recently used. Starters are never evicted (guaranteed palette floor), nor is anything
  // in the composition currently on screen. #130: a generated tool is archived to the durable
  // library BEFORE it leaves the registry, so an evicted tool is recoverable in a later session.
  async evictTools(): Promise<void> {
    const inUse = new Set(((this.composition as any).layers ?? []).map((l: any) => l?.tool));
    for (const name of this.registry.keys()) {
      if (this.registry.size <= this.cfg.maxTools) return;
      if (STARTER_NAMES.has(name) || inUse.has(name)) continue;
      const tool = this.registry.get(name);
      if (tool) await this.archiveTool(tool);
      this.registry.delete(name);
      this.push({ type: "tool-evicted", name });
    }
  }

  // #130: archive a generated tool (called on generation and on eviction). Content-addressed by
  // sha256(draw) so an identical draw body dedups to one library entry. A failure surfaces as a
  // single `status` event (no silent in-memory fallback). No-op when the archive is disabled.
  async archiveTool(tool: ToolDef): Promise<void> {
    const store = this.archive;
    if (!store) return;
    const hash = await toolHash(tool.draw);
    const rec: ArchiveToolRecord = {
      name: tool.name,
      desc: tool.desc,
      params: tool.params,
      draw: tool.draw,
      session: this.traces?.id ?? "",
      ts: Date.now(),
      hash,
    };
    const err = await store.putTool(rec);
    if (err) this.push({ type: "status", text: `archive putTool failed: ${err}` });
  }

  // #130: flush every local trace to the external store (gzipped), then prune the rotating buffer
  // to its cap (keeping the currently-open session). #125 snapshots flush through putBlob once
  // that issue lands; the sink is already wired. A failure sets last_err and emits one status
  // event — never a silent pretend-persistence. Returns {flushed, pending, ok}.
  async flushArchive(now = Date.now()): Promise<{ flushed: number; pending: number; ok: boolean }> {
    const store = this.archive;
    const ts = this.traces;
    if (!store || !ts) return { flushed: 0, pending: ts?.list().length ?? 0, ok: false };
    let flushed = 0;
    let ok = true;
    let errText = "";
    for (const e of ts.list()) {
      let bytes: Uint8Array;
      try {
        bytes = Deno.readFileSync(`${ts.dir}/${e.id}.jsonl`);
      } catch (err) {
        ok = false;
        errText = emsg(err);
        continue;
      }
      const err = await store.putTrace(e.id, new Uint8Array(gzipSync(bytes)));
      if (err) {
        ok = false;
        errText = err;
        continue;
      }
      flushed += 1;
    }
    if (ok) {
      this.archiveFlushed += flushed;
      this.archiveLastOk = now;
      this.archiveLastErr = "";
      this.pruneTraces();
    } else {
      this.archiveLastErr = errText || "archive flush failed";
      this.push({ type: "status", text: `archive flush failed: ${this.archiveLastErr}` });
    }
    return { flushed, pending: ts.list().length, ok };
  }

  // Keep the rotating local buffer bounded: drop the oldest CLOSED sessions beyond TRACE_KEEP.
  // The currently-open session (ts.id) is never pruned — it is still being appended to.
  private pruneTraces(): void {
    const ts = this.traces;
    if (!ts) return;
    const keep = this.cfg.traceKeep;
    const closed = ts.list().filter((e) => e.id !== ts.id); // newest first
    const victims = closed.slice(keep - 1); // beyond the cap, oldest (tail)
    for (const v of victims) {
      try {
        Deno.removeSync(`${ts.dir}/${v.id}.jsonl`);
      } catch { /* best effort */ }
    }
  }

  // #130: seed the registry from the durable tool library (env-gated). Picks a curated subset —
  // distinct names not already in the registry, newest first, capped at SEED_LIBRARY_COUNT — so a
  // good tool from one session is available in the next. Each candidate is smoke-tested; a
  // failure is skipped with a status event (never crashes boot). Idempotent.
  async seedFromLibrary(): Promise<number> {
    const store = this.archive;
    if (!store) return 0;
    const seen = new Set<string>();
    const distinct: ArchiveToolRecord[] = [];
    for (const r of await store.listTools()) { // newest ts first
      if (this.registry.has(r.name) || seen.has(r.name)) continue;
      seen.add(r.name);
      distinct.push(r);
    }
    let seeded = 0;
    for (const r of distinct.slice(0, this.cfg.seedLibraryCount)) {
      const tool: ToolDef = { name: r.name, desc: r.desc, params: r.params, draw: r.draw };
      const err = this.smokeTest(tool);
      if (err) {
        this.push({ type: "status", text: `library seed skipped ${r.name}: ${err}` });
        continue;
      }
      this.registry.set(tool.name, tool);
      this.push({ type: "tool", tool, updated: false, seeded: true });
      seeded += 1;
    }
    return seeded;
  }

  get running(): boolean {
    return this.enabled;
  }

  push(ev: unknown): void {
    const wrapped = { seq: ++this.seq, ev };
    this.events.push(wrapped);
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    // #124: persist every event as one JSONL line. No fallback — an fs error surfaces as a single
    // guarded `status` event (never swallowed, never faked in memory). The guard prevents recursion.
    const store = this.traces;
    if (store && !(ev as { __traceErr?: boolean })?.__traceErr) {
      const err = store.append(JSON.stringify(wrapped));
      if (err) {
        this.events.push({ seq: ++this.seq, ev: { type: "status", text: `trace write failed: ${err}`, __traceErr: true } });
      }
    }
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
    await this.stateRecent();
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
    let raw: string;
    try {
      raw = await this.streamComplete(
        "distill",
        DISTILL_SYSTEM,
        `Transcript:\n${recent}\n\nJSON:`,
        220,
        () => {},
        signal,
        this.cfg.distillTimeoutMs,
      );
    } catch (e) {
      this.push({ type: "status", text: `distill ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const j = extractJson(raw) as any;
    if (!j || typeof j.mood !== "string") return;
    // #94: the distill lane ran E2EE, but its OUTPUT brief must carry no verbatim room words
    // downstream — sanitize before it reaches the paint crew (possibly hosted).
    const { brief, scrubbed } = sanitizeDistilled(j, recent);
    this.brief = { ...brief, avoid: this.brief.avoid }; // #92: keep a pending self-nudge steer alive
    if (scrubbed.length) {
      this.push({ type: "status", text: `distill brief sanitized (verbatim dropped): ${scrubbed.join(", ")}` });
    }
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
    let raw: string;
    try {
      raw = await this.streamComplete(
        "decoder",
        DECODER_SYSTEM,
        `Open topics: ${open}\nSegments:\n${lines}\n\nJSON:`,
        600,
        () => {},
        signal,
        this.cfg.decoderTimeoutMs,
      );
    } catch (e) {
      this.push({ type: "activity", who: "decoder", state: e instanceof Error ? e.message : String(e) });
      return;
    }
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

  /** Resolve how a lane reaches its model. Hearing lanes ALWAYS take an e2ee path (they read the
   *  room); paint lanes may optionally route to a plaintext hosted endpoint when their BASE_URL is
   *  configured — permitted only because their input is sanitized (#94). The critic is
   *  compositor-class: it reads only composition signatures, so it shares the compositor's hosted
   *  transport when that is configured. */
  route(lane: Lane): Route {
    const e2ee = (model: string): Route["transport"] => model.endsWith("-TEE") ? "chutes-e2ee" : "near-e2ee";
    if (lane === "judge") return { lane, model: this.cfg.judgeModel, transport: e2ee(this.cfg.judgeModel) };
    if (lane === "distill") return { lane, model: this.cfg.distillModel, transport: e2ee(this.cfg.distillModel) };
    if (lane === "decoder") return { lane, model: this.cfg.decoderModel, transport: e2ee(this.cfg.decoderModel) };
    if (lane === "state" || lane === "convtype") {
      return { lane, model: this.cfg.stateModel, transport: e2ee(this.cfg.stateModel) };
    }
    if (lane === "critic") {
      if (this.cfg.compositorBaseUrl) {
        return { lane, model: this.cfg.criticModel, transport: "hosted", baseUrl: this.cfg.compositorBaseUrl, apiKey: this.cfg.compositorApiKey };
      }
      return { lane, model: this.cfg.criticModel, transport: e2ee(this.cfg.criticModel) };
    }
    if (lane === "toolsmith") {
      if (this.cfg.toolsmithBaseUrl) {
        return { lane, model: this.cfg.toolsmithModel, transport: "hosted", baseUrl: this.cfg.toolsmithBaseUrl, apiKey: this.cfg.toolsmithApiKey };
      }
      return { lane, model: this.cfg.toolsmithModel, transport: e2ee(this.cfg.toolsmithModel) };
    }
    if (this.cfg.compositorBaseUrl) {
      return { lane, model: this.cfg.compositorModel, transport: "hosted", baseUrl: this.cfg.compositorBaseUrl, apiKey: this.cfg.compositorApiKey };
    }
    return { lane, model: this.cfg.compositorModel, transport: e2ee(this.cfg.compositorModel) };
  }

  // #126: every call composes the lane signal with a per-call deadline, so a stalled TCP stream
  // (nearStream/chutesStream) can't wedge a lane forever — the lane AbortController only fires on
  // stop, so without this one hung stream freezes the while-loop. On a deadline the call throws a
  // stable, lane-nameable error ("timeout after 60s") the caller prefixes with its lane and
  // surfaces as a status event, then continues. No fallback, no retry.
  async streamComplete(lane: Lane, system: string, user: string, maxTokens: number, onDelta = (_: string) => {}, signal?: AbortSignal, timeoutMs = 0): Promise<string> {
    let deadline: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sig = signal;
    if (timeoutMs > 0) {
      deadline = new AbortController();
      timer = setTimeout(() => deadline!.abort(), timeoutMs);
      // The deadline must not keep a quiet process (or a fast unit test) alive on its own; it
      // still fires while real work — the serve loop, an active test — keeps the loop up.
      try { Deno.unrefTimer(timer as unknown as number); } catch { /* non-Deno: best effort */ }
      sig = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    }
    try {
      if (this.streams) return await this.streams.complete(lane, system, user, maxTokens, onDelta, sig);
      const r = this.route(lane);
      const body = { max_tokens: maxTokens, temperature: 0.25, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
      let content = "";
      const cb = (t: string) => {
        content += t;
        onDelta(t);
      };
      if (r.transport === "hosted") await hostedStream(r.apiKey!, r.baseUrl!, r.model, body, cb, sig);
      else if (r.transport === "chutes-e2ee") await chutesStream(this.cfg.chutesKey, r.model, body, cb, sig);
      else await nearStream(this.cfg.nearKey, this.cfg.attestPins, r.model, body, cb, sig);
      return content;
    } catch (e) {
      // If OUR deadline fired (not a lane stop or an upstream error), throw the stable message.
      if (deadline?.signal.aborted) throw new Error(`timeout after ${timeoutMs / 1000}s`);
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async judgeRecent(force = false): Promise<GoodPoint | null> {
    if (!force && Date.now() - this.lastJudgeAt < 15_000) return null;
    const text = this.recentText(60_000);
    if (text.length < 20) return null;
    this.lastJudgeAt = Date.now();
    // #126: judge runs on demand (no lane signal) — give it its own deadline so a hung judge
    // stream surfaces as "judge timeout after 30s" instead of wedging /listen or the otter loop.
    let judge: JudgeResult | null;
    if (this.judgeOverride) {
      judge = await this.judgeOverride(text);
    } else {
      let raw: string;
      try {
        raw = await this.streamComplete("judge", JUDGE_SYSTEM, `Transcript:\n${text}\n\nJSON:`, 180, () => {}, undefined, this.cfg.judgeTimeoutMs);
      } catch (e) {
        this.push({ type: "status", text: `judge ${e instanceof Error ? e.message : String(e)}` });
        return null;
      }
      judge = parseJudge(raw);
    }
    if (!isBanger(judge)) return null;
    const point = { t: Date.now(), quote: judge.quote, why: judge.why, score: judge.score };
    this.ledger.push(point);
    if (this.ledger.length > 80) this.ledger.splice(0, this.ledger.length - 80);
    // #94 privacy cleave: the brief carries ONLY abstract descriptors (sanitizeBrief) — the
    // verbatim quote and the judge's `why` flow to the client alone (goodpoint.point), so no LLM
    // downstream of the judge (toolsmith/compositor, possibly hosted) can read the room's words.
    this.brief = { ...sanitizeBrief(point), avoid: this.brief.avoid }; // #92 nudge steer survives
    this.push({ type: "goodpoint", point, brief: this.brief });
    return point;
  }

  // #83: one extra periodic judge-loop call after judgeRecent — recap, topic-shift detection, and a
  // running audience/purpose/register estimate. 30s throttle; a repeated topic is not re-pushed.
  async stateRecent(force = false): Promise<ConversationState | null> {
    if (!force && Date.now() - this.lastStateAt < 30_000) return null;
    const text = this.recentText(90_000);
    if (text.length < 20) return null;
    this.lastStateAt = Date.now();
    const prior = this.lastTopic ? `Prior topic: ${this.lastTopic}\n` : "";
    const call = async (kind: StateKind, system: string): Promise<string> => {
      if (this.stateOverride) return (await this.stateOverride(kind, text)) ?? "";
      try {
        return await this.streamComplete("state", system, `Transcript:\n${text}\n${prior}JSON:`, 160, () => {}, undefined, this.cfg.stateTimeoutMs);
      } catch (e) {
        // #126: lane-named status; "" parses as a miss so the prior read stands (no flicker, no fallback).
        this.push({ type: "status", text: `state ${e instanceof Error ? e.message : String(e)}` });
        return "";
      }
    };
    const recap = parseRecap(await call("recap", RECAP_SYSTEM));
    if (recap) this.recap = recap.recap;
    const shift = parseShift(await call("shift", SHIFT_SYSTEM));
    if (shift) {
      if (shift.shifted && shift.topic && shift.topic.toLowerCase() !== this.lastTopic.toLowerCase()) {
        this.shifts.push({ t: Date.now(), topic: shift.topic });
        if (this.shifts.length > 30) this.shifts.splice(0, this.shifts.length - 30);
      }
      if (shift.topic) this.lastTopic = shift.topic;
    }
    const flow = parseFlow(await call("flow", FLOW_SYSTEM));
    if (flow) this.estimate = flow;
    const state: ConversationState = {
      recap: this.recap,
      shifts: this.shifts,
      estimate: this.estimate,
      last_topic: this.lastTopic,
    };
    this.push({ type: "state", state });
    return state;
  }

  // #88: conversation-type verdict. Shares the judge loop's machinery (NEAR e2ee via
  // streamComplete, strict JSON) and is fired from the SAME otter-loop iteration as
  // judgeRecent — no new timer. Throttled to one call per ~20s window (lastConvTypeAt). The
  // typeOverride seam lets evidence runs mock the LLM (no NEAR key) while still driving REAL
  // transcript text through the pipeline. A parse miss leaves the prior verdict in place
  // rather than blanking — no flicker, no fake.
  async convTypeRecent(force = false): Promise<ConversationType | null> {
    if (!force && Date.now() - this.lastConvTypeAt < 20_000) return null;
    const text = this.recentText(60_000);
    if (text.length < 20) return null;
    this.lastConvTypeAt = Date.now();
    let verdict: ConversationType | null;
    if (this.typeOverride) {
      verdict = await this.typeOverride(text);
    } else {
      let typeRaw: string;
      try {
        typeRaw = await this.streamComplete("convtype", TYPE_SYSTEM, `Transcript:\n${text}\n\nJSON:`, 160, () => {}, undefined, this.cfg.stateTimeoutMs);
      } catch (e) {
        // #126: lane-named status; the prior verdict stands (staging's parse-miss rule), no fallback.
        this.push({ type: "status", text: `convtype ${e instanceof Error ? e.message : String(e)}` });
        return null;
      }
      verdict = parseConvType(typeRaw);
    }
    if (!verdict || !verdict.type) return null;
    this.convType = verdict;
    this.push({ type: "conv-type", convType: verdict });
    return verdict;
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
    this.lastToolsmithTurnAt = Date.now();
    this.push({ type: "activity", who: "toolsmith", state: "thinking" });
    const existing = [...this.registry.keys()].join(", ") || "(none)";
    // #92: a self-nudge may have set a one-shot brief.avoid — steer the toolsmith off over-used
    // tools this turn, then clear it (the nudge is consumed).
    const avoid = this.brief.avoid && this.brief.avoid.length
      ? `\nAvoid these (already overused — build something deliberately UNLIKE them): ${this.brief.avoid.join(", ")}`
      : "";
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
      "toolsmith",
      TOOLSMITH_SYSTEM,
      `Existing tools: ${existing}\nBrief: ${JSON.stringify(this.brief)}${avoid}\nBuild one distinct compact layer tool. JSON only:`,
      1600,
      (t) => {
        deltaBuf += t;
        if (deltaBuf.length > 120 || Date.now() - lastFlush > 400) flush();
      },
      signal,
      this.cfg.toolsmithTimeoutMs,
    );
    flush();
    if (avoid) this.brief.avoid = undefined; // one-shot: the nudge steered this turn
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
    await this.archiveTool(tool); // #130: archive on generation
    await this.evictTools();
  }

  async compositorTurn(signal: AbortSignal): Promise<void> {
    this.lastCompositorTurnAt = Date.now();
    if (!this.registry.size) {
      this.push({ type: "activity", who: "compositor", state: "waiting for tools" });
      return;
    }
    this.push({ type: "activity", who: "compositor", state: "composing" });
    const palette = [...this.registry.values()].map((t) => `${t.name}(${t.params.map((p) => p.name).join(",")}) - ${t.desc}`).join("\n");
    const raw = await this.streamComplete(
      "compositor",
      COMPOSITOR_SYSTEM,
      `Palette:\n${palette}\n\nBrief:\n${JSON.stringify(this.brief)}\n\nCurrent: ${JSON.stringify(this.composition)}\n\nJSON:`,
      400,
      () => {},
      signal,
      this.cfg.compositorTimeoutMs,
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

  // --- self-eval (issue #92): detect visual staleness and self-regulate ---

  /** Quantize a composition to a signature: sorted tool set + params rounded so small deltas collapse. */
  signatureOf(comp: unknown): string {
    const layers = ((comp as any)?.layers as any[] | undefined) ?? [];
    const norm = layers
      .filter((l) => l && typeof l.tool === "string")
      .map((l) => ({
        tool: String(l.tool),
        params: Object.fromEntries(
          Object.entries(l.params || {})
            .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
            .map(([k, v]) => [k, Math.round((v as number) * 5) / 5]), // 0.2 bucket
        ),
      }))
      .sort((a, b) => (a.tool < b.tool ? -1 : 1));
    return JSON.stringify(norm);
  }

  /** Record one composition; update the rolling staleness score + per-tool usage. Returns the score. */
  recordComposition(comp: unknown = this.composition): number {
    this.compositionCount++;
    const sig = this.signatureOf(comp);
    this.recentSigs.push(sig);
    if (this.recentSigs.length > this.STALE_WINDOW) this.recentSigs.shift();
    this.staleness = this.recentSigs.filter((s) => s === sig).length;
    for (const l of ((comp as any)?.layers as any[] | undefined) ?? []) {
      if (l && typeof l.tool === "string") this.toolUseCount.set(l.tool, (this.toolUseCount.get(l.tool) ?? 0) + 1);
    }
    return this.staleness;
  }

  /** Retire the most-used non-starter tool still in the registry; returns its name ("" if none).
   *  Starters are protected (guaranteed palette floor — a self-nudge must not burn the hand-built
   *  toolbox); in-use tools are NOT protected — the point of a retire is to force the compositor off
   *  its crutch. (#92 integration with #130's starter-protected LRU.) */
  retireMostUsedTool(): string {
    let name = "";
    let best = -1;
    for (const [t, n] of this.toolUseCount) {
      if (n > best && this.registry.has(t) && !STARTER_NAMES.has(t)) {
        best = n;
        name = t;
      }
    }
    if (name) {
      this.registry.delete(name);
      this.toolUseCount.delete(name);
      const layers = ((this.composition as any)?.layers as any[] | undefined) ?? [];
      const kept = layers.filter((l) => l && l.tool !== name);
      if (kept.length !== layers.length) this.composition = { layers: kept };
    }
    return name;
  }

  /** Escalating self-regulation (a perturb brief → b avoid → c retire), cycling. Keeps banger emphasis. */
  selfNudge(): void {
    this.nudgeCount++;
    const level = (this.nudgeCount - 1) % 3;
    const emphasis = this.brief.emphasis; // preserve a banger's emphasis across the nudge
    let action = "";
    if (level === 0) {
      const moods = ["sparse", "dense", "kinetic", "calm", "angular", "organic", "warm", "cold"];
      const pick = moods[Math.floor(Math.random() * moods.length)];
      this.brief = {
        mood: `self-nudge: steer toward ${pick}`,
        emphasis,
        tone: this.brief.tone || "deliberately varied",
        direction: `deliberately unlike the last run — push ${pick}`,
      };
      action = `perturb brief → ${pick}`;
    } else if (level === 1) {
      const over = [...this.toolUseCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t]) => t)
        .filter((t) => this.registry.has(t));
      this.brief = { ...this.brief, emphasis, avoid: over };
      action = over.length ? `toolsmith avoid: ${over.join(", ")}` : "toolsmith avoid: (palette empty)";
    } else {
      const retired = this.retireMostUsedTool();
      action = retired ? `retire most-used tool: ${retired}` : "retire: (no tools to retire)";
    }
    this.lastNudgeAt = Date.now();
    this.lastNudgeAction = action;
    this.recentSigs = []; // observe fresh after intervening
    this.staleness = 0;
    this.push({ type: "activity", who: "self-eval", state: `self-nudge: ${action}` });
  }

  /** Optional compositor-class critic; only fires when configured (override or ENABLE_CRITIC env). */
  async criticTurn(signal: AbortSignal): Promise<void> {
    const recent = this.recentSigs.slice(-5);
    const verdict = this.criticOverride
      ? await this.criticOverride(recent)
      : await this.streamComplete(
        "critic",
        COMPOSITOR_SYSTEM,
        `Recent composition signatures:\n${recent.join("\n")}\n\nAre the last 5 visually distinct? If not, name ONE concrete change (mood/motion). One short line:`,
        60,
        () => {},
        signal,
        this.cfg.compositorTimeoutMs,
      );
    const line = String(verdict || "").trim().slice(0, 160);
    if (line) {
      this.brief = { ...this.brief, direction: `${this.brief.direction} [critic: ${line}]` };
      this.push({ type: "activity", who: "self-eval", state: `critic: ${line}` });
    }
  }

  /** Weave-loop hook: observe the latest composition and self-regulate / critique as needed.
   *  Lives on the compositor lane, so it idles with the weave (#90) — no new timer, composes like
   *  #83/#88 do instead of adding a subsystem. */
  async observeComposition(signal: AbortSignal): Promise<void> {
    this.recordComposition();
    if (this.staleness >= this.STALE_THRESHOLD) {
      this.selfNudge();
      return; // nudge reset; skip critic this cycle
    }
    if (
      this.compositionCount > 0 && this.compositionCount % this.CRITIC_EVERY === 0 &&
      (this.criticOverride || this.cfg.enableCritic)
    ) {
      try {
        await this.criticTurn(signal);
      } catch (e) {
        if (!signal.aborted) this.push({ type: "status", text: `critic: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
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
    const loop = async (who: string, turn: (s: AbortSignal) => Promise<void>, pause: number) => {
      while (!ac.signal.aborted) {
        try {
          await turn(ac.signal);
        } catch (e) {
          // #126: prefix the lane name so a per-call deadline reads "toolsmith timeout after 60s"
          // (not a bare message); then continue to the next turn.
          if (!ac.signal.aborted) this.push({ type: "status", text: `${who} ${e instanceof Error ? e.message : String(e)}` });
        }
        await delay(pause);
      }
    };
    loop("toolsmith", (s) => this.toolsmithTurn(s), 1200).finally(() => {});
    loop("compositor", async (s) => { await this.compositorTurn(s); await this.observeComposition(s); }, 1400).finally(() => {});
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
          if (added.length) await this.convTypeRecent();
          if (added.length) await this.stateRecent();
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
        // #130: flush the rotating trace buffer to the durable archive on a cadence.
        const now = Date.now();
        if (this.archive && now - this.lastArchiveFlushAt > this.cfg.archiveFlushMs) {
          this.lastArchiveFlushAt = now;
          this.flushArchive(now).catch(() => {});
        }
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
      attestation,
    });
  }
  if (req.method === "GET" && path === "/goodpoints") return json({ goodpoints: app.ledger });
  if (req.method === "GET" && path === "/conv-type") {
    return json({ type: app.convType.type, rationale: app.convType.rationale, last_at: app.lastConvTypeAt });
  }
  if (req.method === "GET" && path === "/state") {
    return json({ recap: app.recap, shifts: app.shifts, estimate: app.estimate, last_topic: app.lastTopic });
  }
  if (req.method === "POST" && path === "/snapshot") {
    // #125: client-captured canvas jpeg. Validate content-type + magic bytes + size before storing;
    // a store/fs failure becomes a `status` event for every viewer (no silent swallow, no mock).
    const ct = (req.headers.get("content-type") || "").toLowerCase();
    const clen = Number(req.headers.get("content-length") || 0);
    if (!ct.startsWith("image/jpeg")) return json({ error: "expected image/jpeg" }, 400);
    if (clen && clen > SNAP_MAX_BYTES) return json({ error: "body exceeds 2MB" }, 400);
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length < 2 || !(bytes[0] === 0xff && bytes[1] === 0xd8)) return json({ error: "not a jpeg" }, 400);
    if (bytes.length > SNAP_MAX_BYTES) return json({ error: "body exceeds 2MB" }, 400);
    const { ref, evicted, err } = await app.snapshots.store(app.sessionId, bytes);
    if (!ref) {
      app.push({ type: "status", text: `snapshot store failed: ${err}` });
      return json({ error: err }, 500);
    }
    if (evicted.length) app.push({ type: "status", text: `snapshots: capped ${app.sessionId}, evicted ${evicted.length} oldest (${evicted[0]})` });
    return json(ref, 201);
  }
  if (req.method === "GET" && path === "/snapshots") {
    return json(await app.snapshots.list());
  }
  const snap = path.match(/^\/snapshots\/([^/]+)\/([^/]+)$/);
  if (req.method === "GET" && snap) {
    const src = await app.snapshots.read(snap[1], decodeURIComponent(snap[2]));
    if (!src) return new Response("not found", { status: 404 });
    const buf = new Uint8Array(src); // ArrayBuffer-backed copy (BlobPart needs ArrayBuffer, not SharedArrayBuffer)
    return new Response(new Blob([buf], { type: "image/jpeg" }), { headers: { "cache-control": "public, max-age=300" } });
  }
  // full palette snapshot: a fresh viewer must not depend on tool events still being in the
  // (500-capped) events buffer.
  if (req.method === "GET" && path === "/tools") return json({ tools: [...app.registry.values()] });
  // #130: the durable tool library — archived tools (one per draw-body hash), served back across sessions.
  if (req.method === "GET" && path === "/tools/library") {
    if (!app.archive) return json({ tools: [], backend: "none" });
    return json({ tools: await app.archive.listTools(), backend: app.archive.name });
  }
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
  // #124: list every session trace on disk → [{id, started, bytes, events}].
  if (req.method === "GET" && path === "/traces") {
    return json(app.traces?.list() ?? []);
  }
  // #124: stream a session trace back as NDJSON (content-type application/x-ndjson).
  if (req.method === "GET" && path.startsWith("/traces/")) {
    const id = path.slice("/traces/".length);
    const fh = app.traces?.openRead(id) ?? null;
    if (!fh) return new Response("trace not found", { status: 404 });
    return new Response(fh.readable, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  }
  // #130: durable archive — list flushed traces, stream one back (gunzipped), force a flush.
  if (req.method === "GET" && path === "/archive/traces") {
    if (!app.archive) return json({ traces: [], backend: "none" });
    return json({ traces: await app.archive.listTraces(), backend: app.archive.name });
  }
  if (req.method === "GET" && path.startsWith("/archive/traces/")) {
    const id = path.slice("/archive/traces/".length);
    if (!app.archive) return new Response("archive disabled", { status: 404 });
    const gz = await app.archive.readTrace(id);
    if (!gz) return new Response("trace not found", { status: 404 });
    return new Response(new Uint8Array(gunzipSync(gz)), { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  }
  if (req.method === "POST" && path === "/archive/flush") {
    const r = await app.flushArchive();
    return json({
      ok: r.ok,
      flushed: r.flushed,
      pending: r.pending,
      last_ok: app.archiveLastOk,
      last_err: app.archiveLastErr,
      backend: app.archive?.name ?? "none",
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
      lanes: {
        // #126: per-lane last_turn_at so a wedged lane is visible remotely. A lane claiming
        // running with a stale last_turn_at (past its timeout_ms) is the signature of a hang.
        toolsmith: { last_turn_at: app.lastToolsmithTurnAt, running: app.weaveRunning, timeout_ms: app.cfg.toolsmithTimeoutMs },
        compositor: { last_turn_at: app.lastCompositorTurnAt, running: app.weaveRunning, timeout_ms: app.cfg.compositorTimeoutMs },
        otter: { last_turn_at: app.lastFetchAt, running: app.otterRunning },
        decoder: { last_turn_at: app.lastDecodeAt, timeout_ms: app.cfg.decoderTimeoutMs },
      },
      ledger_count: app.ledger.length,
      conv_type: { type: app.convType.type, rationale_len: app.convType.rationale.length, last_at: app.lastConvTypeAt },
      state: { recap_len: app.recap.length, shifts: app.shifts.length, last_topic: app.lastTopic },
      tools: { count: app.registry.size, max: app.cfg.maxTools },
      graph: { nodes: app.graphNodes.length, topics: app.graphTopics.length, undecoded: app.decodeQueue.length - app.decodedCount },
      mic_segments: app.micSeq,
      // #94: per-lane routing replaces the flat e2ee block. Hearing lanes are e2ee by construction;
      // paint lanes report "hosted" only when BASE_URL is configured. Never emits keys or URLs.
      routing: (["judge", "distill", "decoder", "state", "convtype", "critic", "toolsmith", "compositor"] as Lane[]).map((lane) => {
        const r = app.route(lane);
        return {
          lane,
          model: r.model,
          transport: r.transport,
          hears_room: HEARING_LANES.includes(lane),
          ...(lane === "critic" ? { enabled: app.cfg.enableCritic } : {}),
        };
      }),
      // #105: NEAR key attestation state — verified, or degraded-to-unverified on pin drift.
      attestation,
      self_eval: {
        staleness: app.staleness,
        stale_window: app.STALE_WINDOW,
        stale_threshold: app.STALE_THRESHOLD,
        composition_count: app.compositionCount,
        nudge_count: app.nudgeCount,
        last_nudge_at: app.lastNudgeAt,
        last_nudge_action: app.lastNudgeAction,
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
      trace: app.traces
        ? { session_id: app.traces.id, events_written: app.traces.events, write_ok: app.traces.writeOk }
        : { session_id: "", events_written: 0, write_ok: false },
      archive: app.archive
        ? {
            backend: app.archive.name,
            flushed: app.archiveFlushed,
            pending: app.traces?.list().length ?? 0,
            last_ok: app.archiveLastOk,
            last_err: app.archiveLastErr,
          }
        : { backend: "none", flushed: 0, pending: 0, last_ok: 0, last_err: "" },
      snapshot: {
        dir: app.snapshots.dir,
        session_id: app.sessionId,
        write_ok: app.snapshots.writeOk,
        written: app.snapshots.written,
        last_err: app.snapshots.lastErr,
      },
    });
  }
  if (req.method === "POST" && path === "/reset") {
    app.transcript = [];
    app.ledger = [];
    app.seen.clear();
    app.cursor = 0;
    app.brief = { mood: "", emphasis: "", tone: "", direction: "" };
    app.recap = "";
    app.shifts = [];
    app.lastTopic = "";
    app.lastStateAt = 0;
    app.convType = { type: "", rationale: "" };
    app.lastConvTypeAt = 0;
    app.estimate = { audience: "", purpose: "", register: "" };
    app.events = [];
    app.seq = 0;
    app.graphNodes = [];
    app.graphTopics = [];
    app.decodeQueue = [];
    app.decodedCount = 0;
    app.micSeq = 0;
    app.registry.clear();
    app.composition = { layers: [] };
    app.recentSigs = [];
    app.staleness = 0;
    app.compositionCount = 0;
    app.nudgeCount = 0;
    app.lastNudgeAt = 0;
    app.lastNudgeAction = "";
    app.toolUseCount.clear();
    await app.flushArchive(); // #130: archive the closing session before rotating to a fresh one
    app.traces?.rotate(); // #124: start a fresh session trace file
    app.sessionId = newSessionId(); // #125: rotate the snapshot session alongside the reset
    app.seedTools();
    return json({ ok: true });
  }
  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  Deno.serve({ port: Number(Deno.env.get("PORT") || "8080") }, (req) => handler(req, { env: Deno.env.toObject() }));
}
