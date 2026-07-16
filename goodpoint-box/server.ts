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

const TOOLSMITH_SYSTEM = `You build compact animated canvas layer tools for a realtime visual compositor.
Return STRICT JSON only:
{"name":"snake_name","desc":"one line","params":[{"name":"speed","default":1,"min":0,"max":3}],"draw":"(ctx,p,t,w,h,txt)=>{...}"}
Use only CanvasRenderingContext2D, Path2D, Math, and the txt caption. No DOM, network, imports, or per-pixel loops.`;

const COMPOSITOR_SYSTEM = `You are a realtime VJ compositor. Pick 2-5 layer tools from the palette and tune parameters to match the brief. Return STRICT JSON only:
{"layers":[{"tool":"name","params":{"speed":1.2}}]}`;

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
    return added;
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
    const raw = await this.streamComplete(
      this.cfg.toolsmithModel,
      TOOLSMITH_SYSTEM,
      `Existing tools: ${existing}\nBrief: ${JSON.stringify(this.brief)}\nBuild one distinct compact layer tool. JSON only:`,
      1200,
      () => {},
      signal,
    );
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
    comp.layers = comp.layers.filter((l: any) => l && this.registry.has(l.tool)).slice(0, 5);
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
    const loop = async () => {
      while (!ac.signal.aborted) {
        try {
          await this.toolsmithTurn(ac.signal);
          await this.compositorTurn(ac.signal);
        } catch (e) {
          if (!ac.signal.aborted) this.push({ type: "status", text: e instanceof Error ? e.message : String(e) });
        }
        await delay(1800);
      }
    };
    loop().finally(() => {});
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
    return json({ ok: true });
  }
  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  Deno.serve({ port: Number(Deno.env.get("PORT") || "8080") }, (req) => handler(req, { env: Deno.env.toObject() }));
}
