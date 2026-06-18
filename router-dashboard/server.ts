// router-dashboard — live member leaderboard + insights across Router instances.
//
// Each instance is treated as a "host" (alignOS sense): a node with its own feed,
// members, and privacy posture. The dashboard maps the hosts, ranks members, and
// (with an LLM key) distills a public, abstract weekly highlight per host.
//
// PRIVACY:
//  - Instances are private by default (fail-closed); only `"private":false` (the
//    public notebook) is public.
//  - Private plaintext is hidden anonymously (🔒) and unlocked by VIEW_TOKEN — EXCEPT
//    the owner's own posts (ME), which are always syndicatable (the owner may share
//    their own content). Other members stay gated.
//  - Public posts are not re-syndicated; we link out to the source page.
//  - Weekly highlights are an LLM-distilled ABSTRACT (no raw post text), shown publicly.
//
// ctx.env: INSTANCES (JSON [{name,base,key,private?,entryPath?}]), VIEW_TOKEN, ME,
//   LLM_API_KEY, LLM_BASE, LLM_MODEL (OpenAI-compatible; ZAI or bitrouter), REFRESH_MS, LIMIT, ALIASES.

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36";
const DEFAULT_ALIASES: Record<string, string> = { socrates1024: "amiller" };
const BOTS = new Set(["testbot", "router-bot", "lark-bot-teleport", "clawteedah", "coderstar_bot"]);
const isBot = (h: string) => BOTS.has(h) || /[-_]?bot$/.test(h);
const COLORS = ["#0969da", "#1a7f37", "#8250df", "#bc4c00", "#bf3989"];
const DISPLAY_CAP = 60;
const HL_TTL = 6 * 3600000;
const RANGES: { key: string; label: string; ms: number }[] = [
  { key: "", label: "All time", ms: 0 },
  { key: "7d", label: "Last 7 days", ms: 7 * 86400000 },
  { key: "1d", label: "Last 24h", ms: 86400000 },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
function tsOf(e: any): number {
  const t = e?.timestamp ?? e?.createdAt ?? e?.created_at ?? 0;
  if (typeof t === "string") { const n = Date.parse(t); return isNaN(n) ? 0 : n; }
  return typeof t === "number" ? t : 0;
}
const dateOf = (ms: number) => ms ? new Date(ms).toISOString().slice(0, 10) : "????-??-??";
const textOf = (e: any) => String(e?.summary ?? e?.entry ?? e?.text ?? e?.content ?? "").replace(/\s+/g, " ").trim();
const parseCookie = (h: string | null) => Object.fromEntries((h ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map((p) => [p[0], decodeURIComponent(p.slice(1).join("="))]));
const qs = (params: Record<string, string | undefined | null>) => {
  const parts = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`);
  return parts.length ? `?${parts.join("&")}` : ".";
};

type Post = { instance: string; id: string; ts: number; text: string; url: string; private: boolean };
type Snapshot = { at: number; errors: Record<string, string>; names: string[]; privInst: string[]; posts: Record<string, Post[]> };
type Row = { member: string; by: Record<string, number>; total: number };
type View = { rows: Row[]; totals: Record<string, number> };

let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;
const hlCache = new Map<string, { at: number; text: string }>();

async function compute(env: Record<string, string>): Promise<Snapshot> {
  const insts: { name: string; base: string; key: string; private?: boolean; entryPath?: string }[] = JSON.parse(env.INSTANCES || "[]");
  const limit = Number(env.LIMIT || 8000);
  const aliases: Record<string, string> = { ...DEFAULT_ALIASES, ...(env.ALIASES ? JSON.parse(env.ALIASES) : {}) };
  const canon = (h: string) => aliases[h] ?? h;

  const errors: Record<string, string> = {};
  const posts: Record<string, Post[]> = {};
  const names = insts.map((i) => i.name);
  const privInst = insts.filter((i) => i.private !== false).map((i) => i.name);

  for (const i of insts) {
    const instPrivate = i.private !== false;
    const tmpl = i.entryPath || "/entry?id={id}";
    try {
      const r = await fetch(`${i.base}/api/entries?limit=${limit}&key=${i.key}`, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const arr: any[] = Array.isArray(d) ? d : (d.entries ?? d.results ?? []);
      for (const e of arr) {
        const h = e?.handle;
        if (!h) continue;
        const m = canon(h);
        const id = String(e?.id ?? e?._id ?? "");
        const priv = instPrivate
          || (Array.isArray(e?.to) && e.to.length > 0)
          || !!e?.hidden || !!e?.ai_only || !!e?.aiOnly
          || (typeof e?.visibility === "string" && e.visibility !== "public");
        (posts[m] ??= []).push({ instance: i.name, id, ts: tsOf(e), text: textOf(e), url: id ? `${i.base}${tmpl.replace("{id}", id)}` : "", private: priv });
      }
    } catch (e) {
      errors[i.name] = String((e as Error).message ?? e);
    }
  }
  for (const m of Object.keys(posts)) posts[m].sort((a, b) => b.ts - a.ts);
  return { at: Date.now(), errors, names, privInst, posts };
}

function getData(env: Record<string, string>): Promise<Snapshot> {
  const ttl = Number(env.REFRESH_MS || 600000);
  if (cache && Date.now() - cache.at < ttl) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = compute(env)
    .then((d) => { cache = d; inflight = null; return d; })
    .catch((e) => { inflight = null; if (cache) return cache; throw e; });
  return inflight;
}

// Dedup key: same author + same normalized text ⇒ same logical post (collapses
// cross-instance simulcast copies, which share text but have distinct ids).
const normKey = (p: Post) => { const t = p.text.replace(/\s+/g, " ").trim().toLowerCase(); return t ? t.slice(0, 80) : `__${p.instance}:${p.id}`; };
type Logical = { origin: string; instances: string[]; p: Post; publicUrl: string };
// Collapse a member's posts into logical posts; origin = first host (primary-first
// by s.names order) the post appears on. dedupe=false ⇒ each raw post is its own.
function logicalPosts(s: Snapshot, ps: Post[], since: number, dedupe: boolean): Logical[] {
  const win = ps.filter((p) => !since || p.ts >= since);
  if (!dedupe) return win.map((p) => ({ origin: p.instance, instances: [p.instance], p, publicUrl: s.privInst.includes(p.instance) ? "" : p.url }));
  const groups = new Map<string, Post[]>();
  for (const p of win) { const k = normKey(p); const g = groups.get(k); if (g) g.push(p); else groups.set(k, [p]); }
  return [...groups.values()].map((g) => {
    const instances = [...new Set(g.map((x) => x.instance))];
    const origin = instances.slice().sort((a, b) => s.names.indexOf(a) - s.names.indexOf(b))[0];
    const pub = g.find((x) => !s.privInst.includes(x.instance));
    return { origin, instances, p: g.find((x) => x.instance === origin) ?? g[0], publicUrl: pub?.url ?? "" };
  });
}
function buildView(s: Snapshot, since: number, dedupe: boolean): View {
  const merged: Record<string, Record<string, number>> = {};
  for (const [m, ps] of Object.entries(s.posts)) {
    for (const lp of logicalPosts(s, ps, since, dedupe)) (merged[m] ??= {})[lp.origin] = (merged[m][lp.origin] ?? 0) + 1;
  }
  const rows = Object.entries(merged)
    .map(([member, by]) => ({ member, by, total: Object.values(by).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);
  const totals = Object.fromEntries(s.names.map((n) => [n, rows.reduce((acc, r) => acc + (r.by[n] ?? 0), 0)]));
  return { rows, totals };
}
const sinceFor = (range: string) => { const ms = RANGES.find((r) => r.key === range)?.ms ?? 0; return ms ? Date.now() - ms : 0; };

// ── LLM weekly highlights (public abstract; no raw post text leaves) ──
// Provider-agnostic OpenAI-compatible chat/completions. Point LLM_BASE at ZAI
// (https://api.z.ai/api/coding/paas/v4) or bitrouter (https://api.bitrouter.ai/v1,
// attested) etc. LLM_BASE may be the full chat/completions URL or just the base.
async function callLLM(env: Record<string, string>, system: string, user: string): Promise<string | null> {
  const key = env.LLM_API_KEY;
  if (!key) return null;
  const base = env.LLM_BASE || "https://api.z.ai/api/coding/paas/v4";
  const url = base.endsWith("/chat/completions") ? base : `${base.replace(/\/$/, "")}/chat/completions`;
  const model = env.LLM_MODEL || "glm-4.6";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 2200, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
      if (res.ok) return (await res.json())?.choices?.[0]?.message?.content?.trim() ?? null;
      const t = await res.text();
      if (!(res.status === 404 && /guardrail|data policy/i.test(t)) || attempt === 2) return null;
    } catch { return null; }
  }
  return null;
}

async function getHighlights(env: Record<string, string>, s: Snapshot, board: string): Promise<string | null> {
  if (!env.LLM_API_KEY) return null;
  const cached = hlCache.get(board);
  if (cached && Date.now() - cached.at < HL_TTL) return cached.text;
  const since = Date.now() - 7 * 86400000;
  // Use origin-attributed logical posts: a cross-instance (simulcast) post is
  // summarized only under its origin host, so the three hosts' highlights don't
  // all repeat the same mirrored items.
  const lines: string[] = [];
  for (const ps of Object.values(s.posts)) {
    for (const lp of logicalPosts(s, ps, since, true)) {
      if (lp.origin === board && lp.p.text) lines.push("- " + lp.p.text);
    }
  }
  if (lines.length < 2) return null;
  const sys = [
    "You write the HIGHLIGHTS of a technical team's week for a sharp external stakeholder who wants to quickly grasp what this team actually shipped and how they operate.",
    "From the notebook posts, surface the 3-5 MOST SIGNIFICANT and CONCRETE items: what shipped, what was decided, a real technical breakthrough, a surprising finding, a notable collaboration or change of direction. Lead with the biggest.",
    "Hard rules:",
    "- SPECIFIC, never generic. Name the actual project / feature / decision. BANNED phrasings: 'continued to', 'various', 'posted updates', 'made progress on several', 'worked on a number of'. If a bullet could describe any team in any week, cut it.",
    "- One line each, ~10-16 words, punchy. No sub-bullets, no intro, no conclusion.",
    "- Insight over inventory — prefer the notable and surprising over routine housekeeping.",
    "- Never include secrets, API keys, tokens, or credentials.",
    "Output ONLY the bullets, each starting with '- '.",
  ].join("\n");
  const txt = await callLLM(env, sys, `Last 7 days on "${board}" (${lines.length} distinct posts):\n${lines.slice(0, 120).join("\n")}`);
  if (txt) hlCache.set(board, { at: Date.now(), text: txt });
  return txt;
}

// Non-blocking access: peek the cache; kick off background generation on a miss.
// Reasoning models (glm-5.1) are slow, so page loads never await the LLM.
const hlInProgress = new Set<string>();
const hlPeek = (board: string): string | null => { const c = hlCache.get(board); return c && Date.now() - c.at < HL_TTL ? c.text : null; };
function hlKick(env: Record<string, string>, s: Snapshot, board: string): void {
  if (!env.LLM_API_KEY || hlPeek(board) || hlInProgress.has(board)) return;
  hlInProgress.add(board);
  getHighlights(env, s, board).catch(() => {}).finally(() => hlInProgress.delete(board));
}
const renderHL = (txt: string | null, env: Record<string, string>) =>
  txt ? `<div class=hl><div class=hlh>📋 This week</div>${txt.split("\n").filter((l) => l.trim()).map((l) => `<div class=hli>${esc(l.replace(/^[-*]\s*/, ""))}</div>`).join("")}</div>`
      : (env.LLM_API_KEY ? `<div class="hl muted">📋 This week — generating… (auto-refreshes shortly)</div>` : `<div class="hl muted">Weekly highlights: set LLM_API_KEY (+ LLM_BASE/LLM_MODEL) to enable.</div>`);

const STYLE = `<style>
:root{--bg:#f6f8fa;--panel:#ffffff;--line:#d0d7de;--text:#1f2328;--mut:#656d76;--acc:#0969da;--soft:#eaeef2}
body{background:var(--bg);color:var(--text);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:32px}
a{color:inherit;text-decoration:none}h1{font-size:20px;margin:0 0 4px}h2{margin:14px 0 0}
.sub{color:var(--mut);margin-bottom:18px;font-size:12px}
.nav{display:flex;gap:8px;margin-bottom:16px}
.nav a{padding:5px 12px;border:1px solid var(--line);border-radius:7px;color:var(--mut);font-size:12px;background:var(--panel)}
.nav a.active{background:var(--acc);border-color:var(--acc);color:#fff}
.warn{background:#fff1e7;border:1px solid #ffb77c;color:#9a3412;padding:8px 12px;border-radius:8px;margin-bottom:16px;font-size:12px}
.locknote{background:#ddf4ff;border:1px solid #54aeff;color:#0a3069;padding:8px 12px;border-radius:8px;margin-bottom:14px;font-size:12px}
.login{display:inline-flex;gap:6px;margin:0 0 16px}
.login input{background:#fff;border:1px solid var(--line);color:var(--text);border-radius:6px;padding:5px 8px;font:inherit}
.login button{background:var(--acc);border:0;color:#fff;border-radius:6px;padding:5px 12px;cursor:pointer;font:inherit}
.authok{color:#1a7f37;font-size:12px;margin-bottom:14px;display:block}
.cards{display:flex;gap:14px;margin-bottom:24px;flex-wrap:wrap}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 18px;min-width:130px}
.card.err{border-color:#ffb77c}.card .k{color:var(--mut);font-size:12px}.card .v{font-size:24px;font-weight:700}
.card .e{color:#9a3412;font-size:10px;margin-top:2px}
table{border-collapse:collapse;width:100%;max-width:940px}
td,th{padding:6px 10px;border-bottom:1px solid var(--soft);text-align:right}
th{color:var(--mut);font-weight:600;border-bottom:1px solid var(--line)}
.nm,td.nm,th.nm{text-align:left}.rk{color:var(--mut)}.z{color:var(--line)}
tr.row:hover{background:var(--soft);cursor:pointer}.nm a:hover{color:var(--acc);text-decoration:underline}
.tot{font-weight:700;color:var(--acc)}.bar{min-width:180px;white-space:nowrap}.bar .seg{display:inline-block;height:10px;border-radius:2px;vertical-align:middle}
.bars,.tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;align-items:center}.tabs{margin-bottom:10px}
.tab{padding:5px 12px;border:1px solid var(--line);border-radius:7px;color:var(--mut);font-size:12px;background:var(--panel)}
.tab.active{background:var(--acc);border-color:var(--acc);color:#fff}.tab:hover{border-color:var(--acc)}
.rlabel{color:var(--mut);font-size:11px;margin-right:2px}
.legend{display:flex;gap:14px;margin:0 0 14px;font-size:11px;color:var(--mut);flex-wrap:wrap}
.legend span{display:inline-flex;align-items:center;gap:5px}.legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.bot{background:#fff8c5;color:#7d4e00;font-size:10px;padding:1px 5px;border-radius:4px;margin-left:6px}
.al{color:var(--mut);font-size:11px;margin-left:6px}tr.me{background:#ddf4ff}
.back{color:var(--acc);font-size:13px}.detail{max-width:940px}
.ig{margin:18px 0 6px;color:var(--mut);font-size:12px;border-bottom:1px solid var(--line);padding-bottom:4px}
.post{padding:7px 0;border-bottom:1px solid var(--soft);display:flex;gap:12px}
.post .d{color:var(--mut);white-space:nowrap}.post .t{color:var(--text)}.post a.t:hover{color:var(--acc)}
.post .priv{color:var(--mut);font-style:italic}.post .out{color:var(--acc)}
.synced{font-size:10px;color:#8250df;background:#fbefff;border:1px solid #d9b3ff;border-radius:4px;padding:1px 5px;white-space:nowrap}
.onel{font-size:10px;color:var(--mut)}
.mesh{display:flex;gap:16px;flex-wrap:wrap;max-width:1000px}
.node{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;min-width:280px;flex:1}
.node.primary{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc) inset}
.nhead{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px}
.badge{font-size:10px;padding:1px 7px;border-radius:10px;border:1px solid var(--line);color:var(--mut);font-weight:400}
.badge.pri{background:#ddf4ff;border-color:#54aeff;color:#0a3069}.badge.pub{background:#dafbe1;border-color:#4ac26b;color:#1a7f37}.badge.prv{background:#ffebe9;border-color:#ff8182;color:#cf222e}
.nmeta{color:var(--mut);font-size:11px;margin:6px 0;word-break:break-all}
.ntop{font-size:12px;margin:6px 0}
.hl{background:var(--soft);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:12px}
.hl.muted{color:var(--mut)}.hlh{font-weight:700;margin-bottom:4px}.hli{margin:3px 0}
.flowline{color:var(--mut);font-size:12px;margin:14px 0}
</style>`;

function rangeBar(range: string, keep: Record<string, string | undefined>): string {
  return `<div class=bars><span class=rlabel>range:</span>${RANGES.map((r) =>
    `<a class="tab${range === r.key ? " active" : ""}" href="${qs({ ...keep, range: r.key || undefined })}">${esc(r.label)}</a>`).join("")}</div>`;
}
const nav = (view: string) =>
  `<div class=nav><a class="${view === "" ? "active" : ""}" href=".">🏆 Leaderboard</a><a class="${view === "map" ? "active" : ""}" href="?view=map">🗺 Instance map</a></div>`;

function leaderboard(s: Snapshot, v: View, env: Record<string, string>, board: string | null, range: string, dedupe: boolean): string {
  const me = env.ME ?? "";
  const priv = new Set(s.privInst);
  const lock = (n: string) => priv.has(n) ? " 🔒" : "";
  const dedupeToggle = (extra: Record<string, string | undefined>) =>
    `<a class=rlabel style="margin-left:6px;color:var(--acc)" href="${qs({ ...extra, range: range || undefined, raw: dedupe ? "1" : undefined })}">${dedupe ? "deduped ✓ — show raw" : "raw — dedupe"}</a>`;
  const colorFor = (n: string) => COLORS[Math.max(0, s.names.indexOf(n)) % COLORS.length];
  const nameTags = (m: string) => (isBot(m) ? ` <span class=bot>bot</span>` : "") + (m === me && me ? ` <span class=al>=socrates1024</span>` : "");
  const rowCls = (m: string) => (me && m === me ? " row me" : " row");
  const tab = (key: string, label: string) =>
    `<a class="tab${(board ?? "") === key ? " active" : ""}" href="${qs({ board: key || undefined, range: range || undefined })}">${esc(label)}${key ? lock(key) : ""}</a>`;
  const tabs = `<div class=tabs>${tab("", "Combined")}${s.names.map((n) => tab(n, n)).join("")}</div>`;
  const ranges = rangeBar(range, { board: board || undefined });
  const cards = s.names.map((n) => {
    const err = s.errors[n];
    return `<div class="card${err ? " err" : ""}"><div class=k><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colorFor(n)};margin-right:5px"></i>${esc(n)}${lock(n)}</div><div class=v>${err ? "—" : v.totals[n]}</div>${err ? `<div class=e>${esc(err)}</div>` : ""}</div>`;
  }).join("");
  const memberLink = (m: string) => qs({ member: m, range: range || undefined });

  if (board && s.names.includes(board)) {
    const col = colorFor(board);
    const ranked = v.rows.filter((r) => r.by[board]).map((r) => ({ m: r.member, n: r.by[board] })).sort((a, b) => b.n - a.n);
    const mx = ranked[0]?.n || 1;
    const rows = ranked.map((r, idx) =>
      `<tr class="${rowCls(r.m)}" onclick="location='${memberLink(r.m)}'"><td class=rk>${idx + 1}</td><td class=nm><a href="${memberLink(r.m)}">@${esc(r.m)}</a>${nameTags(r.m)}</td><td class=tot>${r.n}</td><td class=bar><span class=seg style="width:${Math.round(360 * r.n / mx)}px;background:${col}"></span></td></tr>`
    ).join("");
    return `${tabs}${ranges}<div class=cards>${cards}</div>
<table><tr><th class=rk>#</th><th class=nm>member</th><th>${esc(board)}${lock(board)}</th><th class=nm>　</th></tr>${rows}</table>
<p class=sub>${ranked.length} members active on ${esc(board)}${priv.has(board) ? " (plaintext gated — private)" : ""}.${dedupe ? " Counts are by origin host (simulcast copies merged)." : ""}${dedupeToggle({ board })}</p>`;
  }

  const mx = v.rows[0]?.total || 1;
  const cell = (x?: number) => (x ? `${x}` : `<span class=z>·</span>`);
  const legend = `<div class=legend>${s.names.map((n) => `<span><i style="background:${colorFor(n)}"></i>${esc(n)}${lock(n)}</span>`).join("")}</div>`;
  const rows = v.rows.map((r, idx) => {
    const cols = s.names.map((n) => `<td class=n>${cell(r.by[n])}</td>`).join("");
    const segs = s.names.map((n) => r.by[n] ? `<span class=seg style="width:${Math.round(360 * r.by[n] / mx)}px;background:${colorFor(n)}" title="${esc(n)}: ${r.by[n]}"></span>` : "").join("");
    return `<tr class="${rowCls(r.member)}" onclick="location='${memberLink(r.member)}'"><td class=rk>${idx + 1}</td><td class=nm><a href="${memberLink(r.member)}">@${esc(r.member)}</a>${nameTags(r.member)}</td>${cols}<td class=tot>${r.total}</td><td class=bar>${segs}</td></tr>`;
  }).join("");
  return `${tabs}${ranges}${legend}<div class=cards>${cards}<div class=card><div class=k>members</div><div class=v>${v.rows.length}</div></div></div>
<table><tr><th class=rk>#</th><th class=nm>member</th>${s.names.map((n) => `<th>${esc(n.slice(0, 9))}${lock(n)}</th>`).join("")}<th>total</th><th class=nm>　</th></tr>${rows}</table>
<p class=sub>Click a member for their recent posts · 🔒 = private (plaintext gated, except your own) · public posts link out.${dedupe ? " Each post counts once, under its origin host (simulcast copies merged)." : " Raw per-instance counts (simulcast triple-counts)."}${dedupeToggle({ board: board || undefined })}</p>`;
}

function mapView(s: Snapshot, env: Record<string, string>, hls: Record<string, string | null>): string {
  const v = buildView(s, 0, false); // map shows raw host size (actual feed), not deduped
  const colorFor = (n: string) => COLORS[Math.max(0, s.names.indexOf(n)) % COLORS.length];
  const nodes = s.names.map((n, idx) => {
    const isPrimary = idx === 0;
    const isPriv = s.privInst.includes(n);
    const members = v.rows.filter((r) => r.by[n]).length;
    const top = v.rows.filter((r) => r.by[n]).sort((a, b) => b.by[n] - a.by[n]).slice(0, 3).map((r) => `@${esc(r.member)} (${r.by[n]})`).join(" · ");
    const err = s.errors[n];
    return `<div class="node${isPrimary ? " primary" : ""}">
<div class=nhead><i style="width:10px;height:10px;border-radius:2px;background:${colorFor(n)}"></i>${esc(n)}
<span class="badge ${isPrimary ? "pri" : ""}">${isPrimary ? "primary host" : "secondary"}</span>
<span class="badge ${isPriv ? "prv" : "pub"}">${isPriv ? "private" : "public"}</span></div>
<div class=nmeta>${err ? `⚠ ${esc(err)}` : `${v.totals[n]} posts · ${members} members`}</div>
<div class=ntop>top: ${top || "—"}</div>
${renderHL(hls[n] ?? null, env)}
</div>`;
  }).join("");
  return `${nav("map")}<p class=sub>Each Router instance is a host: its own feed, members, and privacy posture. The primary host fans writes out to the secondaries (simulcast).</p>
<div class=flowline>${esc(s.names[0] ?? "")} ⟶ ${s.names.slice(1).map(esc).join(" · ")}　(writes fan out · reads aggregate)</div>
<div class=mesh>${nodes}</div>`;
}

function memberView(s: Snapshot, member: string, me: string, authed: boolean, range: string, since: number, dedupe: boolean): string {
  const mine = !!me && member === me;
  if (!s.posts[member]) return `<a class=back href="${qs({ range: range || undefined })}">← back</a><p class=sub>No posts found for @${esc(member)}.</p>`;
  const lpsAll = logicalPosts(s, s.posts[member], since, dedupe).sort((a, b) => b.p.ts - a.p.ts);
  const ranges = rangeBar(range, { member });
  const items = lpsAll.slice(0, DISPLAY_CAP).map((lp) => {
    const d = `<span class=d>${dateOf(lp.p.ts)}</span>`;
    const badge = lp.instances.length > 1
      ? ` <span class=synced>⇄ ${lp.instances.map(esc).join("·")}</span>`
      : ` <span class=onel>${esc(lp.instances[0])}</span>`;
    if (lp.publicUrl) return `<div class=post>${d}<a class="t out" href="${esc(lp.publicUrl)}" target=_blank>open ↗</a>${badge}</div>`;
    if (!(mine || authed)) return `<div class=post>${d}<span class="t priv">🔒 private — unlock to view</span>${badge}</div>`;
    const body = lp.p.url ? `<a class=t href="${esc(lp.p.url)}" target=_blank>${esc(lp.p.text) || "(no summary)"}</a>` : `<span class=t>${esc(lp.p.text) || "(no summary)"}</span>`;
    return `<div class=post>${d}${body}${badge}</div>`;
  }).join("");
  const note = dedupe ? `${lpsAll.length} unique posts (cross-instance copies merged)` : `${lpsAll.length} posts (raw)`;
  return `<a class=back href="${qs({ range: range || undefined })}">← back to leaderboard</a>
<h2>@${esc(member)}${mine ? ' <span class=al>(you — syndicatable)</span>' : ""}</h2>
<div class=sub>${note} · ${range || "all time"}</div>
${ranges}<div class=detail>${items || "<p class=sub>No posts in this range.</p>"}</div>`;
}

function authBar(env: Record<string, string>, authed: boolean, hasPrivate: boolean): string {
  if (authed) return `<span class=authok>🔓 unlocked — private plaintext visible · <a href="?logout=1">lock</a></span>`;
  if (!hasPrivate) return "";
  const canLogin = !!env.VIEW_TOKEN;
  const note = `<div class=locknote>🔒 Plaintext of other teams' private posts is hidden (your own posts always show). ${canLogin ? "Enter the view token to unlock everything." : "Logins disabled (no VIEW_TOKEN)."}</div>`;
  return note + (canLogin ? `<form class=login method=get><input name=token type=password placeholder="view token" autocomplete=off><button>unlock</button></form>` : "");
}

function page(s: Snapshot, env: Record<string, string>, opts: { member?: string | null; board?: string | null; view?: string | null; authed: boolean; range: string; dedupe: boolean; hls: Record<string, string | null> }): string {
  const ttlSec = Math.max(30, Math.round(Number(env.REFRESH_MS || 600000) / 1000));
  const ageMin = Math.round((Date.now() - s.at) / 60000);
  const errBanner = Object.keys(s.errors).length
    ? `<div class=warn>⚠ couldn't reach: ${Object.entries(s.errors).map(([n, e]) => `${esc(n)} (${esc(e)})`).join(", ")} — showing the rest.</div>` : "";
  let body: string;
  if (opts.view === "map") body = mapView(s, env, opts.hls);
  else if (opts.member) body = nav("") + memberView(s, opts.member, env.ME ?? "", opts.authed, opts.range, sinceFor(opts.range), opts.dedupe);
  else body = nav("") + leaderboard(s, buildView(s, sinceFor(opts.range), opts.dedupe), env, opts.board ?? null, opts.range, opts.dedupe);
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<meta http-equiv=refresh content="${ttlSec}"><title>Router Member Dashboard</title>${STYLE}
<h1><a href=".">Router Member Dashboard</a></h1>
<div class=sub>posts per member across ${s.names.length} instances · updated ${ageMin}m ago · auto-refreshes every ${Math.round(ttlSec / 60)}m · live from /api/entries</div>
${authBar(env, opts.authed, s.privInst.length > 0)}${errBanner}${body}`;
}

export default async function handler(req: Request, ctx: { env: Record<string, string> }) {
  const url = new URL(req.url);
  const VIEW_TOKEN = ctx.env.VIEW_TOKEN || "";
  const me = ctx.env.ME ?? "";
  const qtok = url.searchParams.get("token");
  const cookieTok = parseCookie(req.headers.get("cookie"))["dash_token"];
  const loggingOut = url.searchParams.has("logout");
  const authed = !loggingOut && !!VIEW_TOKEN && (qtok === VIEW_TOKEN || cookieTok === VIEW_TOKEN);
  const setCookie = loggingOut ? "dash_token=; Max-Age=0; SameSite=Lax"
    : (qtok && qtok === VIEW_TOKEN ? `dash_token=${encodeURIComponent(qtok)}; HttpOnly; SameSite=Lax; Max-Age=604800` : null);
  const range = url.searchParams.get("range") ?? "";
  const since = sinceFor(range);
  const view = url.searchParams.get("view");
  const dedupe = url.searchParams.get("raw") !== "1";

  try {
    const s = await getData(ctx.env);
    if (url.pathname === "/json") {
      const v = buildView(s, since, dedupe);
      return Response.json({ updatedAt: s.at, range: range || "all", deduped: dedupe, errors: s.errors, privateInstances: s.privInst, totals: v.totals, leaderboard: v.rows });
    }
    if (url.pathname === "/member" || url.pathname.startsWith("/member/")) {
      const m = url.pathname.startsWith("/member/") ? decodeURIComponent(url.pathname.slice(8)) : (url.searchParams.get("h") ?? "");
      const mine = !!me && m === me;
      const recent = logicalPosts(s, s.posts[m] ?? [], since, dedupe).sort((a, b) => b.p.ts - a.p.ts).map((lp) => {
        const base = { instances: lp.instances, origin: lp.origin, ts: lp.p.ts };
        if (lp.publicUrl) return { ...base, url: lp.publicUrl };
        if (mine || authed) return { ...base, id: lp.p.id, url: lp.p.url, text: lp.p.text };
        return { ...base, private: true };
      });
      return Response.json({ member: m, range: range || "all", deduped: dedupe, mine, authed, recent });
    }
    if (url.pathname === "/highlights") {
      // Non-blocking: return whatever's cached and kick generation for misses.
      const out: Record<string, string | null> = {};
      for (const n of s.names) { out[n] = hlPeek(n); if (!out[n]) hlKick(ctx.env, s, n); }
      return Response.json({ updatedAt: s.at, pending: s.names.filter((n) => !out[n]), highlights: out });
    }
    const hls: Record<string, string | null> = {};
    if (view === "map") for (const n of s.names) { hls[n] = hlPeek(n); if (!hls[n]) hlKick(ctx.env, s, n); }
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (setCookie) headers["set-cookie"] = setCookie;
    return new Response(page(s, ctx.env, { member: url.searchParams.get("member"), board: url.searchParams.get("board"), view, authed, range, dedupe, hls }), { headers });
  } catch (e) {
    return new Response(`dashboard error: ${(e as Error).message}`, { status: 502 });
  }
}

if (import.meta.main) {
  const env = Object.fromEntries(Object.entries(Deno.env.toObject()));
  Deno.serve({ port: 3000 }, (req) => handler(req, { env }));
}
