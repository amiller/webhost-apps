import { shortCheck, rawHistory, connState, configureOauth3, disconnect, stepConnect } from "./oauth3-client.ts";
import { computeState, snapshotFrom, pushCopy, headWatchDelta, nagLadder } from "./state.ts";
import {
  addSnapshot, recentSnapshots, setState, getState,
  addSub, removeSub, allSubs, lastPushed, markPushed,
  updateSession, pendingSessionMilestone, getSession, initStore,
  recordPush, getPushLog, checkConfirmedActivity, consecutivePolls, cumulativePolls,
  recordCorpus, getCorpus, corpusSize, corpusActivityBetween,
  pendingWatchDetected, sessionShorts,
} from "./store.ts";
import { configurePush, pushAll, vapidPublicKey } from "./push.ts";
import { renderDiary } from "./diary.ts";
import { streakNotif, timeCheckNotif } from "./variants.ts";
import { adapt, readAnswers, ARMS, type Adaptation } from "./adapt.ts";
import { initProbes, openProbe, answerProbe, scoreDue, getProbes, probeStats } from "./probes.ts";
import { renderRoast, draftTweet } from "./roast.ts";

let ready = false;
const POLL_IDLE_MS = 5 * 60 * 1000;
const POLL_ACTIVE_MS = 60 * 1000;
// Verbose/test mode (FEEDLING_VERBOSE=1): watch for ANY watch, not just shorts — poll idle every
// 60s and ping on the first new item of a session so a brief / regular-video watch isn't missed.
const POLL_IDLE_MS_VERBOSE = 60 * 1000;
let oauth3Node = "";
let openrouterKey = "";
let diaryModel = "anthropic/claude-sonnet-4-5";
let nextPollAt = 0;
let verbose = false;
let adminToken = "";
let buildSha = "";

async function readStatic(path: string): Promise<Uint8Array | null> {
  try {
    const url = new URL(`./public${path}`, import.meta.url);
    return await Deno.readFile(url);
  } catch { return null; }
}

function milestoneCopy(activeMin: number, state: ReturnType<typeof getState>): string {
  const e = state?.energy ?? 0;
  if (activeMin <= 30) return `${activeMin} min of confirmed scrolling. Cat is mildly concerned.`;
  if (activeMin <= 60) return `An hour of confirmed scrolling, energy ${e}. Maybe a stretch?`;
  if (activeMin <= 90) return `${activeMin} confirmed minutes — break time.`;
  return `${activeMin} min of confirmed shorts. Cat says: please.`;
}

let lastPoll = { at: 0, error: "" };

// ~20% of sessions get NO probe at all. Without a silent arm you cannot separate "he stopped
// because the question interrupted him" from "he stopped anyway" — every probe is an intervention,
// so reactivity has to be estimated rather than assumed away.
const SILENT_RATE = 0.2;
let sessionSilent = false;

// Recomputed once per CALENDAR DAY, like diary.ts's cache — so an answer lands within a day and
// the thresholds do not thrash tick-to-tick. `adaptation.variant` feeds back in as `current`, so a
// rotation sticks instead of being recomputed from the env seed every day.
let adaptation: Adaptation = { nagScale: 1, reason: "no answers read yet" };
let adaptAnswers: ReturnType<typeof readAnswers> | null = null;
let adaptDay = "";
function currentAdaptation(): Adaptation {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== adaptDay) {
    adaptDay = day;
    // Keep the counts the decision was made FROM. Recomputing them per request made /api/adapt
    // contradict itself within a day — the cached `reason` said 6 "still going" while a freshly
    // read `answers` said 7, because a tap had landed since the day flipped.
    adaptAnswers = readAnswers(getPushLog(), Date.now());
    adaptation = adapt(adaptAnswers);
    console.log(`[adapt] ${adaptDay} scale=${adaptation.nagScale} :: ${adaptation.reason}`);
  }
  return adaptation;
}

async function tick(): Promise<boolean> {
  if (!connState().connected) {
    await stepConnect();
    const c = connState();
    lastPoll = { at: Date.now(), error: c.approveUrl ? `approve feedling on your pod: ${c.approveUrl}` : (c.error || "connecting to your pod…") };
    return false;
  }
  let r;
  try {
    r = await shortCheck();
    lastPoll = { at: Date.now(), error: "" };
  } catch (e) {
    lastPoll = { at: Date.now(), error: (e as Error).message };
    console.error("[tick] shortCheck failed:", (e as Error).message);
    return false;
  }
  const snap = snapshotFrom(r);
  (snap as any).shorts = r.shorts || [];

  // Activity = strict count-delta growth, not the noisy `newShorts` field.
  const prevSnaps = recentSnapshots();
  const prevSnap = prevSnaps.length ? prevSnaps[prevSnaps.length - 1] : null;
  const countDelta = prevSnap ? snap.shortsCount - prevSnap.shortsCount : 0;
  const totalDelta = prevSnap ? snap.totalCount - prevSnap.totalCount : 0;
  // Verbose/test-mode watch signal = a HEAD-ITEM change (headWatchDelta). A new watch (regular,
  // short, or rewatch) lands at position 0, so headId changing is reliable EVEN WHEN totalCount
  // is pinned by YouTube's render window — which it is: the oauth3-server youtube plugin parses
  // only the initial ytInitialData render (no continuations), so for an established account
  // totalCount stays flat across a real watch (observed on staging: 199→199 for hours).
  // totalDelta would NEVER fire there; headWatchDelta does. It also seeds to 0 when either snap
  // lacks a headId (first poll / migration), so a deploy can't fire a spurious watch. Normal
  // mode stays on shorts-count growth exactly as before.
  // A previously-unseen short is the primary signal in BOTH modes (the count delta it replaced
  // reads 0 or negative on a saturated window). Verbose additionally counts any watch at all —
  // a regular video or a rewatch moves headId without adding a short.
  const headDelta = headWatchDelta(prevSnap, snap);
  const hasActivity = snap.newShorts > 0 || (verbose && headDelta > 0);

  await addSnapshot(snap);
  // Capture BEFORE anything can throw below: the history window turns over ~200 items/day and
  // whatever is not written here is unrecoverable — the page carries no dates to backfill from.
  const newToCorpus = await recordCorpus(r.items);

  const prev = getState();
  const state = computeState(recentSnapshots(), prev?.energy ?? 0);
  setState(state);

  const sess = updateSession(hasActivity, snap.newShorts);
  if (sess.newSession) sessionSilent = Math.random() < SILENT_RATE;
  // Score anything whose horizon has elapsed. Runs every tick and reads the corpus, so a probe he
  // ignored still gets an outcome — non-response is not missing data here.
  const scored = await scoreDue(corpusActivityBetween);

  console.log(
    `[tick] verbose=${verbose} watching=${snap.watching} new=${snap.newShorts} count=${snap.shortsCount} ` +
    `total=${snap.totalCount} head=${snap.headId.slice(0, 11)} delta=${countDelta} totalDelta=${totalDelta} ` +
    `headDelta=${headDelta} active=${hasActivity} cumulative=${cumulativePolls()} sessionMin=${sess.sessionMin} ` +
    `corpus=${corpusSize()}(+${newToCorpus}) silent=${sessionSilent} scored=${scored} ` +
    `sessionShorts=${sessionShorts()} state=${state.stateCode} energy=${state.energy}`
  );

  const triggers: string[] = [];
  if (checkConfirmedActivity(5, 5)) triggers.push("confirmed_5");
  let watchDelta = 0;
  if (verbose) {
    const d = pendingWatchDetected(hasActivity, headDelta);
    if (d !== null) { triggers.push("watch_detected"); watchDelta = d; }
  }
  const ad = currentAdaptation();
  const m = pendingSessionMilestone(sess.sessionMin, nagLadder(sess.sessionMin, ad.nagScale));
  if (m !== null) triggers.push(`session_${m}`);
  if (state.stateCode !== lastPushed() && (state.stateCode === "drained" || state.stateCode === "night_owl")) {
    triggers.push(state.stateCode);
    markPushed(state.stateCode);
  }

  for (const t of triggers) {
    let body: string;
    let title = "feedling";
    let url = "";
    let extra = {};
    let probeId = "";
    if (t === "confirmed_5") {
      if (sessionSilent) { console.log("[push] confirmed_5 suppressed — silent control session"); continue; }
      // Randomised PER SEND, so arm is not confounded with date the way daily rotation was.
      const arm = ARMS[Math.floor(Math.random() * ARMS.length)];
      const n = streakNotif(arm, recentSnapshots());
      if (!n) { console.log(`[push] trigger=confirmed_5 arm=${arm} skipped — no material`); continue; }
      ({ title, body, url, extra } = n);
      const opts = (extra as { actions?: { action: string }[] }).actions?.map((a) => a.action) ?? [];
      probeId = (await openProbe(arm as "predict" | "commit", opts)).id;
      extra = { ...extra, probeId };
    }
    else if (t === "watch_detected") body = `you watched something just now — ${watchDelta} new item(s)`;
    else if (t.startsWith("session_")) {
      // These slots carried NO buttons until now, so their zero taps measured nothing. They are the
      // only spare question budget the channel has — spend them on the one probe with an exact
      // answer the app already holds.
      body = milestoneCopy(Number(t.slice("session_".length)), state);
      if (!sessionSilent) {
        const n = timeCheckNotif(sess.sessionMin);
        title = n.title; body = n.body; extra = n.extra;
        const opts = (n.extra as { actions?: { action: string }[] }).actions?.map((a) => a.action) ?? [];
        probeId = (await openProbe("timecheck", opts, n.truth)).id;
        extra = { ...extra, probeId };
      }
    }
    else body = pushCopy[state.stateCode];
    try {
      const rep = await pushAll(title, body, url, extra);
      console.log(`[push] trigger=${t} sent=${rep.sent} pruned=${rep.pruned}`);
      await recordPush({
        at: Date.now(),
        trigger: t,
        body,
        probeId: probeId || undefined,
        probeKind: probeId ? (t === "confirmed_5" ? (extra as { variant?: string }).variant : "timecheck") : undefined,
        sent: rep.sent,
        pruned: rep.pruned,
        endpoints: rep.details.map((d) => ({
          host: (() => { try { return new URL(d.endpoint.replace("...", "")).host; } catch { return d.endpoint.slice(0, 40); } })(),
          ok: d.ok,
          status: d.status,
          error: d.error,
        })),
      });
    } catch (e) {
      console.error("[push] trigger", t, "failed:", (e as Error).message);
      await recordPush({
        at: Date.now(), trigger: t, body, sent: 0, pruned: 0,
        endpoints: [{ host: "(error)", ok: false, error: (e as Error).message }],
      });
    }
  }
  return hasActivity;
}

const POLL_CONNECT_MS = 4000; // while not connected, poll fast to advance the handshake + catch approval
let loopTimer = 0;
let ticking = false;
function scheduleNext(watching: boolean) {
  clearTimeout(loopTimer);
  const idle = verbose ? POLL_IDLE_MS_VERBOSE : POLL_IDLE_MS;
  const delay = !connState().connected ? POLL_CONNECT_MS : (watching ? POLL_ACTIVE_MS : idle);
  nextPollAt = Date.now() + delay;
  loopTimer = setTimeout(loop, delay) as unknown as number;
}
// Reschedule the single loop to fire soon (used by disconnect / poll-now). Never spawns a
// second chain — there is exactly one loopTimer.
function kickSoon(ms = 60) { clearTimeout(loopTimer); loopTimer = setTimeout(loop, ms) as unknown as number; }

async function loop() {
  if (ticking) return; // single-flight: never overlap ticks (they share connect state)
  ticking = true;
  let watching = false;
  try {
    watching = await tick();
  } catch (e) {
    console.error("[loop] tick error:", (e as Error).message);
  } finally {
    ticking = false;
  }
  scheduleNext(watching);
}

function initOnce(env: Record<string, string>, dataDir: string) {
  if (ready) return;
  initStore(dataDir).catch((e) => console.error("[init] store:", (e as Error).message));
  initProbes(dataDir).catch((e) => console.error("[init] probes:", (e as Error).message));
  oauth3Node = env.OAUTH3_NODE || "https://pod.dstack.soc1024.com/oauth3";
  verbose = /^(1|true|yes|on)$/i.test(env.FEEDLING_VERBOSE || "");
  // Get feedling's scoped token via the SDK connect() handshake — an explicit OAUTH3_TOKEN
  // (owner-minted) still works as an override; otherwise the approved token is persisted here.
  const tokenFile = dataDir ? `${dataDir}/oauth3-token.txt` : "";
  (async () => {
    let stored = "";
    if (tokenFile) { try { stored = (await Deno.readTextFile(tokenFile)).trim(); } catch { /* none yet */ } }
    configureOauth3(oauth3Node, env.OAUTH3_TOKEN || stored, (t) => {
      if (tokenFile) Deno.writeTextFile(tokenFile, t).catch((e) => console.error("[oauth3] token persist:", e.message));
    }, () => {
      if (tokenFile) Deno.remove(tokenFile).catch(() => {});
    });
  })();
  openrouterKey = env.OPENROUTER_API_KEY || "";
  diaryModel = env.DIARY_MODEL || diaryModel;
  adaptation = { nagScale: 1, reason: "no answers read yet" };
  adminToken = env.FEEDLING_ADMIN_TOKEN || "";
  buildSha = env.GIT_SHA || "";
  if (!adminToken) console.warn("[init] FEEDLING_ADMIN_TOKEN unset — every owner route will refuse");

  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    configurePush({
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT || "mailto:you@example.com",
    });
    console.log("[init] push configured");
  } else {
    console.warn("[init] VAPID keys missing — push disabled");
  }

  ready = true;
  console.log(`[init] ready — verbose=${verbose} idle=${verbose ? POLL_IDLE_MS_VERBOSE : POLL_IDLE_MS}ms active=${POLL_ACTIVE_MS}ms node=${oauth3Node}`);
  loopTimer = setTimeout(loop, 3000) as unknown as number;
}

function json(obj: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(obj), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

// Owner gate. No token configured means no owner routes — never open by default.
function isAdmin(req: Request): boolean {
  if (!adminToken) return false;
  return (req.headers.get("authorization") || "") === `Bearer ${adminToken}`;
}
const DENY = () => json({ error: "owner only" }, { status: 401 });

const EXT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

export default async function handler(
  req: Request,
  ctx: { env: Record<string, string>; dataDir?: string },
): Promise<Response> {
  initOnce(ctx.env || {}, ctx.dataDir || "");

  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/_warmup") return new Response("ok");

  if (req.method === "GET" && path === "/api/version") {
    return json({ sha: buildSha, admin: isAdmin(req) });
  }

  if (req.method === "GET" && path === "/api/state") {
    const admin = isAdmin(req);
    const sess = getSession();
    const sessionMin = sess.startedAt ? Math.round((Date.now() - sess.startedAt) / 60_000) : 0;
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(1, Math.min(500, Number(limitParam) | 0)) : 12;
    const recent = recentSnapshots();
    const latest = recent.length ? recent[recent.length - 1] : null;
    return json({
      state: getState(),
      todayHonest: !!(latest as { todayHonest?: boolean })?.todayHonest,
      poll: lastPoll,
      connect: connState(),
      verbose,
      // Titles are what he actually watched — the public feed gets the shape of the
      // session (counts, timing), never the content.
      snaps: recent.slice(-limit).map((s) => admin ? s : { ...s, shorts: undefined }),
      session: {
        startedAt: sess.startedAt,
        lastActivityAt: sess.lastActivityAt,
        minutes: sessionMin,
        consecutiveActivePolls: consecutivePolls(),
        cumulativeActivePolls: cumulativePolls(),
      },
    });
  }
  if (req.method === "GET" && path === "/api/diary") {
    // `force` bypasses the daily cache and spends OpenRouter credit per call. Checked before
    // anything else — an early return below must not become a way around the gate.
    const force = url.searchParams.get("force") === "1";
    if (force && !isAdmin(req)) return DENY();
    const s = getState();
    if (!s) return json({ diary: "" });
    try {
      const diary = await renderDiary(
        s, recentSnapshots(), openrouterKey, diaryModel, force,
      );
      return json({ diary });
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 500 });
    }
  }
  if (req.method === "GET" && path === "/api/history") {
    if (!isAdmin(req)) return DENY();
    try { return json({ items: await rawHistory() }); }
    catch (e) { return json({ error: (e as Error).message }, { status: 503 }); }
  }
  if (req.method === "GET" && path === "/api/roast") {
    if (!isAdmin(req)) return DENY();
    try {
      const items = await rawHistory();
      const roast = await renderRoast(items.map((i) => i.title), openrouterKey, diaryModel,
        url.searchParams.get("force") === "1");
      return json({ roast });
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 503 });
    }
  }
  if (req.method === "GET" && path === "/api/tweet-draft") {
    if (!isAdmin(req)) return DENY();
    try {
      const items = await rawHistory();
      const draft = await draftTweet(items.map((i) => i.title), openrouterKey, diaryModel,
        url.searchParams.get("force") === "1");
      return json({ draft });
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 503 });
    }
  }
  if (req.method === "GET" && path === "/api/pushes") {
    const limit = url.searchParams.get("limit");
    return json({ pushes: getPushLog(limit ? Number(limit) | 0 : undefined) });
  }
  if (req.method === "GET" && path === "/api/subs") {
    if (!isAdmin(req)) return DENY();
    return json({
      subs: allSubs().map((s) => ({
        host: new URL(s.endpoint).host,
        fingerprint: s.endpoint.split("/").slice(-1)[0].slice(0, 12),
        endpoint: s.endpoint,
        createdAt: s.createdAt,
      })),
      dataDir: ctx.dataDir || "(none)",
      nextPollAt,
    });
  }
  if (req.method === "POST" && path === "/api/notif-action") {
    const { action, variant, probeId, at } = await req.json();
    // sw.js has always sent `at`; it used to be discarded, so response latency could only be
    // estimated from push-log adjacency. Correlate by nonce and keep the real timestamp.
    const tapAt = typeof at === "number" && at > 0 ? at : Date.now();
    const matched = probeId ? await answerProbe(probeId, action, tapAt) : false;
    console.log(`[action] variant=${variant} action=${action} probe=${probeId || "-"} matched=${matched}`);
    await recordPush({
      at: tapAt, trigger: `action:${action}`, body: variant ?? "",
      probeId: probeId || undefined,
      sent: 0, pruned: 0, endpoints: [],
    });
    return json({ ok: true, matched });
  }
  if (req.method === "GET" && path === "/api/corpus") {
    // Titles are the private surface — the public feed gets shape, never content (same rule as
    // /api/state's title stripping and /api/history's gate).
    if (!isAdmin(req)) return DENY();
    const since = Number(url.searchParams.get("since") || 0) || 0;
    const items = getCorpus(since);
    return json({ count: items.length, total: corpusSize(), items });
  }
  if (req.method === "GET" && path === "/api/probes") {
    const since = Number(url.searchParams.get("since") || 0) || 0;
    return json({ stats: probeStats(since), probes: isAdmin(req) ? getProbes(since) : undefined });
  }
  if (req.method === "GET" && path === "/api/adapt") {
    const ad = currentAdaptation();
    // `answers` is what `reason` was computed from; `answersNow` is live, so a tap you just made
    // is visible before tomorrow's recompute folds it in.
    return json({
      ...ad,
      answers: adaptAnswers,
      answersNow: readAnswers(getPushLog(), Date.now()),
      computedFor: adaptDay,
    });
  }
  if (req.method === "GET" && path === "/api/variant") {
    return json({ arms: ARMS, randomizedPerSend: true, silentRate: SILENT_RATE });
  }
  if (req.method === "POST" && path === "/api/unsubscribe") {
    if (!isAdmin(req)) return DENY();
    const body = await req.json().catch(() => null) as any;
    if (!body?.endpoint) return json({ error: "missing endpoint" }, { status: 400 });
    await removeSub(body.endpoint);
    return json({ ok: true });
  }
  if (req.method === "GET" && path === "/api/vapid-key") {
    try { return json({ key: vapidPublicKey() }); }
    catch (e) { return json({ error: (e as Error).message }, { status: 503 }); }
  }
  if (req.method === "POST" && path === "/api/subscribe") {
    if (!isAdmin(req)) return DENY();
    const body = await req.json().catch(() => null) as any;
    if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
      return json({ error: "bad subscription" }, { status: 400 });
    }
    await addSub({ endpoint: body.endpoint, keys: body.keys });
    return json({ ok: true });
  }
  if (req.method === "POST" && path === "/api/disconnect") {
    if (!isAdmin(req)) return DENY();
    disconnect();
    kickSoon(100); // reschedule the single loop so a fresh approve URL appears at once
    return json({ ok: true });
  }
  if (req.method === "POST" && path === "/api/poll-now") {
    if (!isAdmin(req)) return DENY();
    await loop(); // single-flight tick + reschedule (no racing with the timer)
    return json({ ok: true });
  }
  if (req.method === "GET" && path === "/api/verbose") {
    return json({ verbose });
  }
  if (req.method === "POST" && path === "/api/verbose") {
    if (!isAdmin(req)) return DENY();
    const body = await req.json().catch(() => null) as any;
    if (body && typeof body.enabled === "boolean") verbose = body.enabled;
    kickSoon(100); // reschedule the single loop so the new idle interval applies at once
    return json({ verbose });
  }
  if (req.method === "POST" && path === "/api/test-push") {
    if (!isAdmin(req)) return DENY();
    const body = "hello from the server 🐈";
    try {
      const r = await pushAll("feedling test", body, "");
      await recordPush({
        at: Date.now(), trigger: "test", body, sent: r.sent, pruned: r.pruned,
        endpoints: r.details.map((d) => ({
          host: (() => { try { return new URL(d.endpoint.replace("...", "")).host; } catch { return d.endpoint.slice(0, 40); } })(),
          ok: d.ok, status: d.status, error: d.error,
        })),
      });
      return json(r);
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 500 });
    }
  }

  if (req.method === "GET") {
    const file = path === "/" || path === "" ? "/index.html" : path;
    const data = await readStatic(file);
    if (!data) return new Response("not found", { status: 404 });
    const ext = file.slice(file.lastIndexOf("."));
    return new Response(data as BodyInit, {
      headers: { "Content-Type": EXT_TYPES[ext] || "application/octet-stream" },
    });
  }
  return new Response("method not allowed", { status: 405 });
}
