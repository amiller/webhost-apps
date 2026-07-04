import { shortCheck, rawHistory, connState, configureOauth3, disconnect, stepConnect } from "./oauth3-client.ts";
import { computeState, snapshotFrom, pushCopy } from "./state.ts";
import {
  addSnapshot, recentSnapshots, setState, getState,
  addSub, removeSub, allSubs, lastPushed, markPushed,
  updateSession, pendingSessionMilestone, getSession, initStore,
  recordPush, getPushLog, checkConfirmedActivity, consecutivePolls, cumulativePolls,
} from "./store.ts";
import { configurePush, pushAll, vapidPublicKey } from "./push.ts";
import { renderDiary } from "./diary.ts";

let ready = false;
const POLL_IDLE_MS = 5 * 60 * 1000;
const POLL_ACTIVE_MS = 60 * 1000;
const SESSION_MILESTONES = [30, 60, 90, 120];
let oauth3Node = "";
let openrouterKey = "";
let diaryModel = "anthropic/claude-sonnet-4-5";
let nextPollAt = 0;

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
  const hasActivity = countDelta > 0;

  await addSnapshot(snap);

  const prev = getState();
  const state = computeState(recentSnapshots(), prev?.energy ?? 0);
  setState(state);

  const sess = updateSession(hasActivity);

  console.log(
    `[tick] watching=${snap.watching} new=${snap.newShorts} count=${snap.shortsCount} delta=${countDelta} ` +
    `active=${hasActivity} cumulative=${cumulativePolls()} state=${state.stateCode} energy=${state.energy}`
  );

  const triggers: string[] = [];
  if (checkConfirmedActivity(hasActivity, 5)) triggers.push("confirmed_5");
  const m = pendingSessionMilestone(cumulativePolls(), SESSION_MILESTONES);
  if (m !== null) triggers.push(`session_${m}`);
  if (state.stateCode !== lastPushed() && (state.stateCode === "drained" || state.stateCode === "night_owl")) {
    triggers.push(state.stateCode);
    markPushed(state.stateCode);
  }

  for (const t of triggers) {
    let body: string;
    if (t === "confirmed_5") body = "5 minutes of solid scrolling. Cat noticed.";
    else if (t.startsWith("session_")) body = milestoneCopy(Number(t.slice("session_".length)), state);
    else body = pushCopy[state.stateCode];
    try {
      const rep = await pushAll("feedling", body, "");
      console.log(`[push] trigger=${t} sent=${rep.sent} pruned=${rep.pruned}`);
      await recordPush({
        at: Date.now(),
        trigger: t,
        body,
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
  const delay = !connState().connected ? POLL_CONNECT_MS : (watching ? POLL_ACTIVE_MS : POLL_IDLE_MS);
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
  oauth3Node = env.OAUTH3_NODE || "https://pod.dstack.soc1024.com/oauth3";
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
  console.log(`[init] ready — idle=${POLL_IDLE_MS}ms active=${POLL_ACTIVE_MS}ms node=${oauth3Node}`);
  loopTimer = setTimeout(loop, 3000) as unknown as number;
}

function json(obj: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(obj), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

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

  if (req.method === "GET" && path === "/api/state") {
    const sess = getSession();
    const sessionMin = sess.startedAt ? Math.round((Date.now() - sess.startedAt) / 60_000) : 0;
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(1, Math.min(500, Number(limitParam) | 0)) : 12;
    return json({
      state: getState(),
      poll: lastPoll,
      connect: connState(),
      snaps: recentSnapshots().slice(-limit),
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
    const s = getState();
    if (!s) return json({ diary: "" });
    try {
      const diary = await renderDiary(
        s, recentSnapshots(), openrouterKey, diaryModel,
        url.searchParams.get("force") === "1",
      );
      return json({ diary });
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 500 });
    }
  }
  if (req.method === "GET" && path === "/api/history") {
    try { return json({ items: await rawHistory() }); }
    catch (e) { return json({ error: (e as Error).message }, { status: 503 }); }
  }
  if (req.method === "GET" && path === "/api/pushes") {
    const limit = url.searchParams.get("limit");
    return json({ pushes: getPushLog(limit ? Number(limit) | 0 : undefined) });
  }
  if (req.method === "GET" && path === "/api/subs") {
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
  if (req.method === "POST" && path === "/api/unsubscribe") {
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
    const body = await req.json().catch(() => null) as any;
    if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
      return json({ error: "bad subscription" }, { status: 400 });
    }
    await addSub({ endpoint: body.endpoint, keys: body.keys });
    return json({ ok: true });
  }
  if (req.method === "POST" && path === "/api/disconnect") {
    disconnect();
    kickSoon(100); // reschedule the single loop so a fresh approve URL appears at once
    return json({ ok: true });
  }
  if (req.method === "POST" && path === "/api/poll-now") {
    await loop(); // single-flight tick + reschedule (no racing with the timer)
    return json({ ok: true });
  }
  if (req.method === "POST" && path === "/api/test-push") {
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
