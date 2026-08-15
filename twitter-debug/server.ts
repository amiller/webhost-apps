// OAuth3 debug console — data hub. The dashboard (web/index.html, served by the
// ws-bridge at /) calls these same-origin /twitter/* endpoints. Two paths over ONE
// sealed jar (held server-side in the TEE, sourced from the OAuth3 vault):
//   - API path: rettiwt-api (reverse-engineered client) — blind, guesses the request
//   - BROWSER path: real Brave via the extension + xdotool, GLM-4.5V vision, CDP trace → reify
//   - REIFY: replay the browser's captured request headlessly — the browser is spent ONCE
//     to observe the real signed request; the capture then replays cheaply (RFC 0001/0000).
import http from 'node:http'
import https from 'node:https'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { submitCompose, typeText, type BoundingBox, type Vector } from './human-mouse.js'
import { locateElement } from './glm-vision.js'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const PORT = Number(process.env.PORT) || 8090
const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:3000'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const execAsync = promisify(exec)

// The screenshot is the browser VIEWPORT; xdotool moves the real X11 cursor in SCREEN coords.
// The viewport sits below the browser chrome, so screen_y = viewport_y + (screenH - shotH).
// Query the actual geometry instead of hardcoding it (was wrongly fixed at 720 → clicks missed).
let screenH = 0
async function displayHeight(): Promise<number> {
  if (!screenH) { const { stdout } = await execAsync('xdotool getdisplaygeometry'); screenH = Number(stdout.trim().split(/\s+/)[1]) }
  return screenH
}

// The sealed jar lives here, in the TEE — never in the client. Sourced from the user's
// OAuth3 vault via the delegated-jar consent flow (see the OAuth3 client below), not hand-fed.
let currentJar: Record<string, string> = {}
const HTTPONLY = new Set(['auth_token', 'kdt'])

// Last browser-observed request per graphql op (the ground truth the API path is diffed against).
const lastTrace: Record<string, { req: any; ts: number }> = {}

// Access control. Reads/observation are public. WRITES (post/like/unlike) and the mouse-moving
// probe are gated on the owner's OAuth3 consent: the dashboard calls /twitter/oauth3/connect,
// the owner approves in the OAuth3 popup, and writes unlock only once that connect is approved
// (oauthToken set — see writeOk below). The connect asks for the "jar" cap, which is the raw
// session credential, so approving it IS consent for this enclave to act on the account; the
// approval screen replaces the former shared DEBUG_SECRET (kept out entirely, no second path).
// Not connected → writes are hard-disabled (safe default).
let browserLock = false, lastBrowserRun = 0
const BROWSER_COOLDOWN = 20_000

// Visibility: what's holding the single browser, and the last frame the automation saw.
let activity: { task: string; step: string; attempt?: number; startedAt: number } | null = null
let lastShot: { buf: Buffer; w: number; h: number; ts: number } | null = null
const setAct = (task: string, step: string, attempt?: number) => {
  activity = { task, step, attempt, startedAt: activity?.startedAt || Date.now() }
  console.log(`[activity] ${task} · ${step}${attempt ? ` (attempt ${attempt})` : ''}`)
}

async function cmd(tool: string, args: any[] = [], timeoutMs = 30_000): Promise<any> {
  const r = await fetch(`${BRIDGE}/api/bridge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }), signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await r.json()
  if (!j.success) throw new Error(`bridge ${tool}: ${j.error || 'failed'}`)
  return j.result
}
const cmdSoft = (tool: string, args: any[] = [], t = 30_000) => cmd(tool, args, t).catch((e: Error) => { console.log(`[cmd soft-fail] ${tool}: ${e.message}`); return null })

function jarToCookies(jar: Record<string, string>) {
  return Object.entries(jar).map(([name, value]) => ({
    name, value, domain: '.x.com', path: '/', secure: true, httpOnly: HTTPONLY.has(name), sameSite: 'None',
  }))
}
const cookieHeader = (jar: Record<string, string>) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')

// ---- OAuth3 delegated-jar client ----------------------------------------------------------
// The x.com jar is owned by the user's OAuth3 vault (populated by their extension/plugin under
// key owner:twitter). We obtain a consent-gated token carrying the "jar" capability, then pull
// the raw jar (TEE→TEE) instead of a manual upload. The token is persisted to a sealed volume so
// a container restart re-fetches the jar with no re-approval — the vault is the source of truth.
const OAUTH3 = process.env.OAUTH3_SERVER || 'https://pod.dstack.soc1024.com/oauth3'
const TOKEN_PATH = process.env.OAUTH3_TOKEN_PATH || '/data/oauth3-token'
let oauthToken: string | null = null
// Writes unlock once the owner has approved the OAuth3 connect (the "jar" cap = the raw session
// credential, so approving it is consent for this enclave to act on the account). The token is
// opaque, so the client can't distinguish caps — today the deployed OAuth3 server grants only
// 'jar'; once it grants a distinct 'write' cap and reflects it here, narrow this to write-only.
const writeOk = () => !!oauthToken
let connectPending: { requestId: string; approveUrl: string } | null = null
// #69: bind the connect to ONE named twitter account (e.g. the bot account, not the owner's
// personal session). Set via the ACCOUNT env to the target's numeric twitter id (the value the
// OAuth3 vault derives from the twid cookie, e.g. "1234567890"). When set it is sent as `account`
// in POST /api/connect so the minted token reads that account's jar, and the consent line names
// it. When unset, single-jar subjects keep working unchanged.
const TWITTER_ACCOUNT = process.env.ACCOUNT || ''

async function saveToken(tok: string) {
  oauthToken = tok
  await mkdir(dirname(TOKEN_PATH), { recursive: true }).catch(() => {})
  await writeFile(TOKEN_PATH, tok, { mode: 0o600 })
}

async function refreshJar(): Promise<{ count: number }> {
  if (!oauthToken) throw new Error('not connected to OAuth3 — connect X on the dashboard')
  const r = await fetch(`${OAUTH3}/api/twitter/jar`, { headers: { Authorization: `Bearer ${oauthToken}` }, signal: AbortSignal.timeout(15_000) })
  const j = await r.json()
  if (!r.ok) {
    // #69: a 409-with-accounts means the subject holds several twitter jars and no account was
    // bound to this token. Log the available accounts (and rethrow them in the message) instead
    // of an opaque failure, so the operator knows to set ACCOUNT to one of them.
    if (r.status === 409 && Array.isArray(j.accounts) && (j.accounts as string[]).length) {
      const accts = (j.accounts as string[]).join(', ')
      console.log(`[oauth3] 409: multiple twitter accounts synced for the subject — set ACCOUNT to one of: ${accts}`)
      throw new Error(`multiple twitter accounts synced — set ACCOUNT to one of: ${accts}`)
    }
    throw new Error(`jar fetch ${r.status}: ${j.error || 'failed'}`)
  }
  currentJar = j.jar || {}
  if (currentJar.auth_token) await cmdSoft('setCookies', [jarToCookies(currentJar)])
  return { count: Object.keys(currentJar).length }
}

async function pollApproval(requestId: string) {
  for (let i = 0; i < 150; i++) { // ~5 min at 2s
    await sleep(2000)
    const j = await fetch(`${OAUTH3}/api/connect/${requestId}`, { signal: AbortSignal.timeout(10_000) }).then(r => r.json()).catch(() => null)
    if (!j) continue
    if (j.status === 'approved' && j.token) {
      await saveToken(j.token); connectPending = null
      await refreshJar().then(r => console.log(`[oauth3] connected — jar refreshed (${r.count} cookies)`)).catch(e => console.log('[oauth3] refresh after approve failed:', e.message))
      return
    }
    if (j.status === 'denied') { connectPending = null; console.log('[oauth3] connect denied'); return }
  }
  connectPending = null
}

async function startConnect(): Promise<{ approveUrl: string; requestId: string }> {
  const r = await fetch(`${OAUTH3}/api/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // 'jar' = the raw session credential (what we act with); 'write' = consent to post/like on the
    // owner's behalf. The deployed OAuth3 server grants 'jar' today; 'write' is requested so the
    // approve page discloses it the moment the server supports the cap.
    // #69: when ACCOUNT names the target twitter account, bind the connect to it so the minted
    // token reads that account's jar (the bot, not the owner's personal session).
    body: JSON.stringify({ plugin: 'twitter', caps: ['jar', 'write'], app: 'twitter-debug', ...(TWITTER_ACCOUNT ? { account: TWITTER_ACCOUNT } : {}) }), signal: AbortSignal.timeout(15_000),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`connect ${r.status}: ${j.error || 'failed'}`)
  connectPending = { requestId: j.requestId, approveUrl: j.approveUrl }
  pollApproval(j.requestId)
  return connectPending
}

// ---- reification (browser trace → candidate unofficial API) ----
const SIGN = ['authorization', 'x-csrf-token', 'x-client-transaction-id', 'content-type', 'x-twitter-active-user', 'x-twitter-auth-type', 'x-twitter-client-language']
const opOf = (u: string) => (u || '').match(/\/graphql\/[^/]+\/([^/?]+)/)?.[1] ?? null
const qidOf = (u: string) => (u || '').match(/\/graphql\/([^/]+)\//)?.[1] ?? null
function pick(h: Record<string, string>, ks: string[]) {
  const lo: Record<string, string> = {}; for (const k in h) lo[k.toLowerCase()] = h[k]
  const o: Record<string, string> = {}; for (const k of ks) if (k in lo) o[k] = lo[k]; return o
}
function reifyOne(e: any) {
  return {
    // Keep the FULL url incl. query string — a GET graphql call carries its variables/features
    // there, so replay needs them. (POST carries them in post_data.)
    op: opOf(e.url), queryId: qidOf(e.url), method: e.method, url: e.url || '',
    signing_headers: pick(e.request_headers || {}, SIGN),
    post_data: e.post_data ?? null, status: e.status ?? null,
    response_body: typeof e.response_body === 'string' ? e.response_body.slice(0, 300) : null,
  }
}
function reify(log: any[]) {
  return (log || []).filter(e => /\/i\/api\/graphql\//.test(e.url || '')).map(reifyOne)
}
function cacheTrace(log: any[]) {
  for (const e of log || []) {
    const op = opOf(e.url); if (!op || !/\/i\/api\/graphql\//.test(e.url) || e.status !== 200) continue
    // Prefer the variant that carries a body (POST) — it replays most reliably.
    const prev = lastTrace[op]
    if (prev && prev.req.post_data && !e.post_data) continue
    lastTrace[op] = { req: reifyOne(e), ts: Date.now() }
  }
}

// ---- timeline → tweets + media (#6) ---------------------------------------------------------
// The feed payoff: map a HomeTimeline GraphQL response to plain tweets, each carrying its media
// entities ({type:'photo'|'video', url}) — photo urls point at pbs.twimg.com, video urls at the
// best-bitrate mp4 on video.twimg.com (poster = the still frame). The dashboard never loads
// those hosts directly: it renders them through the same-origin /twitter/media relay below
// (the otter /frame pattern), so the page itself makes zero twimg.com requests.
type MediaEnt = { type: 'photo' | 'video'; url: string; poster?: string; alt?: string }
// X nests tweets under wrappers (TweetWithVisibilityResults) and tucks media under
// legacy.extended_entities; videos come as several bitrate variants.
function unwrapTweet(res: any): any | null {
  if (!res || typeof res !== 'object') return null
  if (res.__typename === 'TweetWithVisibilityResults') return unwrapTweet(res.tweet?.result)
  return res.__typename === 'Tweet' ? res : null
}
function mapMediaEntity(m: any): MediaEnt | null {
  if (!m || !m.media_url_https) return null
  if (m.type === 'photo') return { type: 'photo', url: m.media_url_https, alt: m.ext_alt_text || undefined }
  if (m.type === 'video' || m.type === 'animated_gif') {
    const mp4 = (m.video_info?.variants || []).filter((v: any) => v.content_type === 'video/mp4')
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))
    return { type: 'video', url: mp4[0]?.url || m.media_url_https, poster: m.media_url_https, alt: m.ext_alt_text || undefined }
  }
  return null
}
function mapTweet(res: any) {
  const t = unwrapTweet(res); if (!t) return null
  const legacy = t.legacy || {}
  // full_text carries a trailing https://t.co/… stub per media entity — cut those ranges back out.
  let text: string = legacy.full_text || ''
  const cuts = ((legacy.entities?.media) || []).map((m: any) => m.indices as [number, number]).filter(Boolean)
    .sort((a, b) => b[0] - a[0])
  for (const [s, e] of cuts) text = text.slice(0, s) + text.slice(e)
  const u = t.core?.user_results?.result
  const media = (((legacy.extended_entities || t.extended_entities || {}).media) || [])
    .map(mapMediaEntity).filter(Boolean) as MediaEnt[]
  return {
    id: t.rest_id ?? legacy.id_str ?? null,
    text: text.trim(),
    by: u?.core?.screen_name ?? u?.legacy?.screen_name ?? null,
    name: u?.core?.name ?? u?.legacy?.name ?? null,
    avatar: u?.avatar?.image_url ?? u?.legacy?.profile_image_url_https ?? null,
    media,   // always present — [] when the tweet is text-only
  }
}
function mapTimeline(json: any) {
  const tweets: any[] = []
  const entries = (json?.data?.home?.home_timeline_urt?.instructions || []).flatMap((i: any) => i.entries || [])
  for (const e of entries) {
    const c = e?.content || {}
    const push = (ic: any) => { if (ic?.tweet_results) { const t = mapTweet(ic.tweet_results.result); if (t) tweets.push(t) } }
    push(c.itemContent)
    for (const it of c.items || []) push(it?.item?.itemContent)
  }
  const photos = tweets.reduce((n, t) => n + t.media.filter((m: MediaEnt) => m.type === 'photo').length, 0)
  const videos = tweets.reduce((n, t) => n + t.media.filter((m: MediaEnt) => m.type === 'video').length, 0)
  return { tweets, counts: { tweets: tweets.length, with_media: tweets.filter((t: any) => t.media.length).length, photos, videos } }
}

async function shot(): Promise<{ b64: string; w: number; h: number }> {
  const dataUrl: string = await cmd('screenshot', [], 20_000)
  const b64 = (dataUrl || '').replace(/^data:image\/\w+;base64,/, '')
  const buf = Buffer.from(b64, 'base64')
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)   // PNG IHDR
  lastShot = { buf, w, h, ts: Date.now() }                    // cache so the live view keeps streaming while busy
  return { b64, w, h }
}

// ---- BROWSER path (extension + xdotool + GLM vision + trace) ----
// Locate an element by description, RETRYING with fresh screenshots — this absorbs the
// browser's slowness + transient vision misses without hand-tuning coordinates.
// Coarse-to-fine locate: GLM-4.5V is ~2-3% off on small targets (e.g. the Post button), enough
// to clip its edge. So locate roughly, crop a window around the estimate, and re-locate where the
// target is large — this nails small buttons without hand-tuning any coordinate.
async function refine(b64: string, desc: string, w: number, h: number, coarse: BoundingBox): Promise<Vector> {
  const cx = coarse.x + coarse.width / 2, cy = coarse.y + coarse.height / 2
  const cw = Math.min(560, w), ch = Math.min(320, h)
  const left = Math.round(Math.min(Math.max(0, cx - cw / 2), w - cw)), top = Math.round(Math.min(Math.max(0, cy - ch / 2), h - ch))
  const crop = await sharp(Buffer.from(b64, 'base64')).extract({ left, top, width: cw, height: ch }).png().toBuffer()
  const fine = await locateElement(crop.toString('base64'), desc, cw, ch).catch(() => null)
  if (!fine) return { x: cx, y: cy }
  return { x: left + fine.x + fine.width / 2, y: top + fine.y + fine.height / 2 }
}
async function locate(task: string, step: string, desc: string, offsetY: number, tries = 3): Promise<BoundingBox> {
  let lastErr = ''
  for (let i = 0; i < tries; i++) {
    setAct(task, `${step} — vision look ${i + 1}/${tries}`)
    const s = await shot()   // caches the frame → the live view shows exactly what vision is looking at
    const coarse = await locateElement(s.b64, desc, s.w, s.h).catch((e: Error) => { lastErr = e.message; return null })
    if (coarse) {
      const c = await refine(s.b64, desc, s.w, s.h, coarse)
      return { x: c.x - 24, y: c.y - 14 + offsetY, width: 48, height: 28 }   // tight box around the refined center
    }
    await sleep(1000)
  }
  throw new Error(`vision could not find after ${tries} tries: ${desc} ${lastErr}`)
}

async function runBrowser(task: string, text?: string) {
  if (!currentJar.auth_token) throw new Error('no jar loaded — connect X via OAuth3')
  activity = { task, step: 'starting', startedAt: Date.now() }
  try {
    setAct(task, 'injecting cookies'); await cmdSoft('setCookies', [jarToCookies(currentJar)])
    const startUrl = task === 'post' ? 'https://x.com/compose/post' : 'https://x.com/home'
    setAct(task, `navigating ${startUrl}`); await cmdSoft('navigate', [startUrl]); await sleep(6000)
    const first = await shot(); const offsetY = (await displayHeight()) - first.h

    if (task === 'trace') {
      setAct(task, 'recording network trajectory')
      await cmd('startTrace'); await sleep(800)
      await cmdSoft('navigate', [startUrl]); await sleep(6500)
      const { network_log } = await cmd('captureTrace')
      cacheTrace(network_log)
      const ops = [...new Set((network_log || []).map((e: any) => opOf(e.url)).filter(Boolean))]
      return { path: 'browser', task, ops, reified: reify(network_log) }
    }

    if (task === 'post') {
      if (!text) throw new Error('post needs text')
      // Act on exact DOM rects (real xdotool input at a precise coordinate) — vision stays the
      // SEEING layer (live view + reified trajectory); DOM rects make the ACTIONS deterministic.
      const rectPt = async (sel: string): Promise<Vector | null> => {
        const r = await cmdSoft('rectOf', [sel], 15_000)
        return r && r.visible ? { x: r.left + r.width / 2, y: r.top + r.height / 2 + offsetY } : null
      }
      let tp: Vector | null = null
      for (let k = 0; k < 4 && !tp; k++) { setAct(task, `wait for composer — ${k + 1}/4`); tp = await rectPt('[data-testid="tweetTextarea_0"]'); if (!tp) await sleep(1200) }
      if (!tp) throw new Error('compose text box never appeared')
      setAct(task, 'typing the tweet'); await typeText(text, tp); await sleep(1200)
      // Trace-as-oracle: the post is DONE only when a CreateTweet 200 is observed. The Post button
      // is a small target GLM clips, so we snap the xdotool click to its exact DOM rect (real input,
      // precise coordinate) and retry the whole thing until X actually accepts it — the feedback loop.
      const attempts: any[] = []
      for (let attempt = 1; attempt <= 2; attempt++) {
        // Confirm the composer still holds an enabled Post button (text landed) before submitting.
        const enabled = await rectPt('[data-testid="tweetButton"]')
        if (!enabled && attempt === 1) throw new Error('Post button never enabled — text did not land')
        await cmd('startTrace'); await sleep(400)
        setAct(task, 'submitting (ctrl+enter)', attempt); await submitCompose(); await sleep(3800)
        setAct(task, 'verifying via network trace', attempt)
        const cap = await cmdSoft('captureTrace', [], 60_000)   // fetching bodies over the VPN can be slow — don't let it error a landed submit
        const network_log = cap?.network_log || []
        cacheTrace(network_log)
        const ct = network_log.find((e: any) => opOf(e.url) === 'CreateTweet')
        attempts.push({ attempt, method: 'ctrl+enter', createTweet: ct ? ct.status : null, traceCaptured: cap !== null })
        if (ct && ct.status === 200) return { path: 'browser', task, posted: true, attempts, reified: [reifyOne(ct)] }
        // Submitted but the trace couldn't be read → don't retry (would risk a duplicate); report unconfirmed.
        if (cap === null) return { path: 'browser', task, posted: 'unconfirmed', attempts, note: 'submitted but trace capture timed out — verify on the account' }
      }
      return { path: 'browser', task, posted: false, attempts, error: 'CreateTweet not observed after 2 attempts' }
    }
    throw new Error(`unknown task ${task}`)
  } finally { activity = null }
}

// ---- API path (rettiwt-api, reverse-engineered) — instrumented on the wire ----
async function rettiwt() {
  if (!currentJar.auth_token || !currentJar.ct0 || !currentJar.twid) throw new Error('no jar loaded — connect X via OAuth3')
  const { Rettiwt } = await import('rettiwt-api')
  // Only the auth-essential cookies — other values (personalization_id="v1_…") contain
  // quotes/specials that break rettiwt's cookie parser and corrupt the twid read.
  const cookieStr = ['auth_token', 'ct0', 'twid', 'kdt'].filter(k => currentJar[k]).map(k => `${k}=${currentJar[k]}`).join(';')
  return new Rettiwt({ apiKey: Buffer.from(cookieStr).toString('base64') })
}
// Monkeypatch https.request to record what a client ACTUALLY sends to x.com — library-agnostic,
// captures follow-redirects/axios alike. This is how we see rettiwt's real request to diff it.
function captureHttps(hostRe: RegExp) {
  const orig = https.request
  const calls: any[] = []
  ;(https as any).request = function (...args: any[]) {
    let opts: any, urlStr: string
    if (typeof args[0] === 'string' || args[0] instanceof URL) { urlStr = args[0].toString(); opts = (args[1] && typeof args[1] === 'object') ? args[1] : {} }
    else { opts = args[0] || {}; urlStr = `https://${opts.hostname || opts.host}${opts.path || ''}` }
    const host = opts.hostname || opts.host || ''
    if (!hostRe.test(String(host)) && !hostRe.test(urlStr)) return (orig as any).apply(this, args)
    const rec: any = { method: (opts.method || 'GET'), url: urlStr, headers: { ...(opts.headers || {}) }, body: '', status: null, response: '' }
    calls.push(rec)
    const req = (orig as any).apply(this, args)
    const ow = req.write.bind(req); req.write = (c: any, ...a: any[]) => { if (c && typeof c !== 'function') rec.body += c.toString(); return ow(c, ...a) }
    const oe = req.end.bind(req); req.end = (c: any, ...a: any[]) => { if (c && typeof c !== 'function') rec.body += c.toString(); return oe(c, ...a) }
    req.on('response', (res: any) => { rec.status = res.statusCode; res.on('data', (d: any) => { if (rec.response.length < 800) rec.response += d.toString('latin1') }) })
    return req
  }
  return { calls, restore: () => { (https as any).request = orig } }
}
async function captureRettiwt(op: string, p: any = {}) {
  const cap = captureHttps(/x\.com|twitter\.com/)
  let error: string | null = null, ok = false
  try { const r = await rettiwt(); await runApi(op, p, r); ok = true }
  catch (e) { error = (e as Error).message }
  finally { cap.restore() }
  const gql = cap.calls.filter(c => /graphql/.test(c.url))
  const c = gql[gql.length - 1] || cap.calls[cap.calls.length - 1] || {}
  const hk = Object.keys(c.headers || {}).map(k => k.toLowerCase())
  return {
    client: 'rettiwt-api', ok, error,
    op: opOf(c.url), queryId: qidOf(c.url), method: c.method || null, url: (c.url || '').split('?')[0] || null,
    forges_xctid: hk.includes('x-client-transaction-id'), status: c.status ?? null,
  }
}
async function runApi(op: string, p: any, r?: any) {
  r = r || await rettiwt()
  if (op === 'timeline') {
    const tl = await r.user.timeline(p.count || 10)
    // #6: surface media entities — rettiwt flattens them to {id,type,url,thumbnailUrl}.
    const mapM = (m: any) => m?.type === 'photo' || m?.type === 'image'
      ? { type: 'photo', url: m.url }
      : { type: 'video', url: m.url, poster: m.thumbnailUrl }
    return { path: 'api', op, tweets: (tl?.list ?? []).map((t: any) => ({ id: t.id, text: t.fullText, by: t.tweetBy?.userName, media: (t.media ?? []).filter(Boolean).map(mapM) })) }
  }
  if (op === 'post') return { path: 'api', op, id: await r.tweet.post({ text: p.text }) }
  if (op === 'like') return { path: 'api', op, tweetId: p.tweetId, ok: await r.tweet.like(p.tweetId) }
  if (op === 'unlike') return { path: 'api', op, tweetId: p.tweetId, ok: await r.tweet.unlike(p.tweetId) }
  throw new Error(`unknown api op ${op}`)
}

// ---- REIFY: replay the browser's captured request headlessly (no browser) ----
async function replayHeadless(req: any) {
  const h: Record<string, string> = {
    ...req.signing_headers,
    'x-twitter-client-language': req.signing_headers['x-twitter-client-language'] || 'en',
    accept: '*/*', origin: 'https://x.com', referer: 'https://x.com/home',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    cookie: cookieHeader(currentJar),
  }
  const r = await fetch(req.url, { method: req.method, headers: h, body: req.method === 'POST' ? req.post_data : undefined, signal: AbortSignal.timeout(20_000) })
  const txt = await r.text()
  let entries: number | null = null, json: any = null
  try { json = JSON.parse(txt); const ins = json?.data?.home?.home_timeline_urt?.instructions || []; const en = ins.find((x: any) => x.entries); entries = en ? en.entries.length : 0 } catch {}
  return { via: 'headless fetch — no browser, pod egress', status: r.status, entries, json, body_head: txt.slice(0, 160) }
}

// The whole story in one call: blind API vs browser-observed truth vs headless replay of it.
async function reifyDiff() {
  let truth = lastTrace['HomeTimeline']
  if (!truth || Date.now() - truth.ts > 180_000) { await runBrowser('trace'); truth = lastTrace['HomeTimeline'] }
  if (!truth) throw new Error('could not observe HomeTimeline from the browser')
  const api = await captureRettiwt('timeline', { count: 10 })
  const { json: _replayJson, ...replay } = await replayHeadless(truth.req)   // json only feeds /twitter/feed — keep panel ④ light
  const b = truth.req
  const reached = !!api.op   // did rettiwt get past X's edge to a GraphQL op at all?
  const diff = [
    { field: 'operation', browser: b.op, api: reached ? api.op : '(blocked before GraphQL)',
      note: reached ? 'rettiwt reads a different surface (UserTweets), not the live home feed' : 'on this egress rettiwt never reaches the API — X serves a challenge at x.com first' },
    { field: 'graphql queryId', browser: b.queryId, api: reached ? api.queryId : '—',
      note: 'persisted-query id drifts each release; the browser uses the live one' },
    { field: 'x-client-transaction-id', browser: 'observed from live page', api: reached ? (api.forges_xctid ? 'forged (blind)' : 'ABSENT') : 'never sent',
      note: 'the browser’s was signed by X’s own JS in-page; a blind client can only guess' },
    { field: 'egress verdict', browser: `${b.status} · replay ${replay.status}`, api: api.ok ? String(api.status) : `✗ ${api.error}`,
      note: 'X rejects the blind client on this egress; the browser-signed request replays cleanly from the same egress' },
  ]
  const verdict = replay.status === 200
    ? `Reification wins: the browser observed the real HomeTimeline request ONCE; that capture replays headlessly (${replay.status}, ${replay.entries} entries) and cheaply — same sealed jar, same egress, no browser. The blind API ${api.ok ? 'reaches only a thinner surface' : 'is rejected before it even reaches the API'}.`
    : `Browser observed HomeTimeline (${b.status}); headless replay returned ${replay.status} — re-observe (the signing window may have rolled).`
  return { intent: 'read home timeline', browser: { op: b.op, queryId: b.queryId, method: b.method, status: b.status, xctid: 'observed' }, api, reify: replay, diff, verdict }
}

// #6: the feed — the reify path's payoff. The browser-observed HomeTimeline capture replays
// headlessly (cheap, same sealed jar, no browser) and maps to tweets WITH their media entities;
// the dashboard renders it. Recaptures through the browser only when the trace is stale.
async function feed() {
  let truth = lastTrace['HomeTimeline']
  if (!truth || Date.now() - truth.ts > 180_000) await runBrowser('trace')
  truth = lastTrace['HomeTimeline']
  if (!truth) throw new Error('could not observe HomeTimeline from the browser')
  const { via, status, json } = await replayHeadless(truth.req)
  const mapped = mapTimeline(json)
  return { via, status, counts: mapped.counts, tweets: mapped.tweets }
}

// ---- HEADLESS ENGINE: the fully-reified path. No browser, no x-client-transaction-id.
// Just the sealed jar (auth_token + ct0) + the graphql queryId (grep'd live from X's JS bundle)
// + feature flags. This is what the browser observation collapses to once you know the shape. ----
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
// X's PUBLIC web-app bearer — identical in every x.com page, not a secret.
const WEB_BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const HOME_FEATURES = { rweb_video_screen_enabled: false, payments_enabled: false, rweb_xchat_enabled: false, profile_label_improvements_pcf_label_in_post_enabled: true, rweb_tipjar_consumption_enabled: true, verified_phone_label_enabled: false, creator_subscriptions_tweet_preview_api_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, responsive_web_grok_analyze_button_fetch_trends_enabled: false, responsive_web_grok_analyze_post_followups_enabled: true, responsive_web_jetfuel_frame: true, responsive_web_grok_share_attachment_enabled: true, articles_preview_enabled: true, responsive_web_edit_tweet_api_enabled: true, graphql_is_translatable_rweb_tweet_is_translatable_enabled: true, view_counts_everywhere_api_enabled: true, longform_notetweets_consumption_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true, tweet_awards_web_tipping_enabled: false, responsive_web_grok_show_grok_translated_post: false, responsive_web_grok_analysis_button_from_backend: true, creator_subscriptions_quote_tweet_preview_enabled: false, freedom_of_speech_not_reach_fetch_enabled: true, standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true, longform_notetweets_rich_text_read_enabled: true, longform_notetweets_inline_media_enabled: true, responsive_web_grok_image_annotation_enabled: true, responsive_web_grok_imagine_annotation_enabled: true, responsive_web_grok_community_note_auto_translation_is_enabled: false, responsive_web_enhance_cards_enabled: false }
const CREATE_FEATURES = { premium_content_api_read_enabled: false, communities_web_enable_tweet_community_results_fetch: true, c9s_tweet_anatomy_moderator_badge_enabled: true, responsive_web_grok_analyze_button_fetch_trends_enabled: false, responsive_web_grok_analyze_post_followups_enabled: true, rweb_cashtags_composer_attachment_enabled: true, responsive_web_jetfuel_frame: true, responsive_web_grok_share_attachment_enabled: true, responsive_web_grok_annotations_enabled: true, responsive_web_edit_tweet_api_enabled: true, rweb_conversational_replies_downvote_enabled: false, graphql_is_translatable_rweb_tweet_is_translatable_enabled: true, view_counts_everywhere_api_enabled: true, longform_notetweets_consumption_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true, content_disclosure_indicator_enabled: true, content_disclosure_ai_generated_indicator_enabled: true, responsive_web_grok_show_grok_translated_post: true, responsive_web_grok_analysis_button_from_backend: true, post_ctas_fetch_enabled: false, longform_notetweets_rich_text_read_enabled: true, longform_notetweets_inline_media_enabled: false, profile_label_improvements_pcf_label_in_post_enabled: true, responsive_web_profile_redirect_enabled: false, rweb_tipjar_consumption_enabled: false, verified_phone_label_enabled: false, articles_preview_enabled: true, rweb_cashtags_enabled: true, responsive_web_grok_community_note_auto_translation_is_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, freedom_of_speech_not_reach_fetch_enabled: true, standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true, responsive_web_grok_image_annotation_enabled: true, responsive_web_grok_imagine_annotation_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true }

let opCache: { ids: Record<string, string>; ts: number; bundle: string } | null = null
// Resolve operationName → queryId live from X's client bundle, so we never hardcode a stale id.
async function operationIds() {
  if (opCache && Date.now() - opCache.ts < 6 * 3600_000) return opCache
  const home = await (await fetch('https://x.com/home', { headers: { cookie: cookieHeader(currentJar), 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(15_000) })).text()
  const bundle = home.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[a-f0-9]+\.js/)?.[0]
  if (!bundle) throw new Error('main.js bundle not found in homepage')
  const js = await (await fetch(bundle, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) })).text()
  const ids: Record<string, string> = {}
  for (const m of js.matchAll(/queryId:"([A-Za-z0-9_-]+)",operationName:"([A-Za-z0-9_]+)"/g)) ids[m[2]] = m[1]
  opCache = { ids, ts: Date.now(), bundle }
  return opCache
}
function engineHeaders() {
  if (!currentJar.auth_token || !currentJar.ct0) throw new Error('no jar loaded — connect X via OAuth3')
  return { authorization: WEB_BEARER, 'x-csrf-token': currentJar.ct0, 'content-type': 'application/json', 'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-client-language': 'en', accept: '*/*', 'user-agent': UA, referer: 'https://x.com/home', origin: 'https://x.com', cookie: cookieHeader(currentJar) }
}
async function engine(op: string, p: any) {
  const { ids, bundle } = await operationIds()
  const call = async (name: string, variables: any, features?: any) => {
    let qid = ids[name]
    // X moved some queryIds out of main.js into lazy chunks (2026-08: HomeTimeline is gone from
    // it) — fall back to the qid the browser actually used for this op (lastTrace), the same
    // source of truth the reify replay rides. No guessing, no stale hardcoded id.
    if (!qid && lastTrace[name]) qid = qidOf(lastTrace[name].req.url) || undefined
    if (!qid) throw new Error(`queryId for ${name} not in bundle`)
    const body: any = { variables, queryId: qid }; if (features) body.features = features
    const r = await fetch(`https://x.com/i/api/graphql/${qid}/${name}`, { method: 'POST', headers: engineHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    return { qid, status: r.status, json: await r.json().catch(() => ({})) }
  }
  const proof = { engine: 'headless fetch — no browser, no x-client-transaction-id', queryId_source: bundle }
  if (op === 'timeline') {
    const c = await call('HomeTimeline', { count: p.count || 50, includePromotedContent: false, latestControlAvailable: true, requestContext: 'launch' }, HOME_FEATURES)
    const mapped = mapTimeline(c.json)
    return { ...proof, op, queryId: c.qid, status: c.status, counts: mapped.counts, tweets: mapped.tweets }
  }
  if (op === 'like' || op === 'unlike') {
    const name = op === 'like' ? 'FavoriteTweet' : 'UnfavoriteTweet'
    const c = await call(name, { tweet_id: String(p.tweetId) })
    return { ...proof, op, queryId: c.qid, status: c.status, result: c.json?.data ?? null, errors: c.json?.errors ?? null }
  }
  if (op === 'post') {
    if (!p.text) throw new Error('post needs text')
    const c = await call('CreateTweet', { tweet_text: p.text, media: { media_entities: [], possibly_sensitive: false }, semantic_annotation_ids: [], disallowed_reply_options: null, semantic_annotation_options: { source: 'UniversalLink' } }, CREATE_FEATURES)
    const res = c.json?.data?.create_tweet?.tweet_results?.result
    return { ...proof, op, queryId: c.qid, status: c.status, tweet_id: res?.rest_id ?? null, errors: c.json?.errors ?? null }
  }
  throw new Error(`unknown engine op ${op}`)
}

async function egress() {
  const r = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(9000) })
  const j = await r.json()
  return { ip: j.ip, org: j.org, city: j.city, region: j.region, country: j.country, proxy: process.env.SOCKS_PROXY || null }
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { res(JSON.parse(b || '{}')) } catch { res({}) } }) })
}

http.createServer(async (req, res) => {
  const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) }
  try {
    const url = (req.url || '').split('?')[0]
    const post = req.method === 'POST'
    if (url === '/twitter/health' || url === '/health') return send(200, { ok: true, jarLoaded: !!currentJar.auth_token })
    if (url === '/twitter/status') return send(200, {
      busy: !!activity,
      activity: activity ? { ...activity, elapsed: Math.round((Date.now() - activity.startedAt) / 1000) } : null,
      shotAge: lastShot ? Math.round((Date.now() - lastShot.ts) / 1000) : null,
    })
    if (url === '/twitter/shot') {
      // While a task holds the single browser, serve the last frame the automation captured —
      // the live view keeps streaming exactly what the vision loop is looking at, never blank.
      if (activity && lastShot) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return res.end(lastShot.buf) }
      const dataUrl: string = await cmd('screenshot', [], 15_000)
      const buf = Buffer.from((dataUrl || '').replace(/^data:image\/\w+;base64,/, ''), 'base64')
      if (buf.length > 24) lastShot = { buf, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ts: Date.now() }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
      return res.end(buf)
    }
    // OAuth3 delegated-jar: connect X once (owner approves in the OAuth3 popup), then the jar is
    // pulled from the vault. No debug secret — the approval screen is the gate. Replaces /setjar.
    if (post && url === '/twitter/oauth3/connect') return send(200, await startConnect())
    if (url === '/twitter/oauth3/status') return send(200, {
      connected: !!oauthToken, jarLoaded: !!currentJar.auth_token,
      count: Object.keys(currentJar).length, pending: connectPending, server: OAUTH3,
      account: TWITTER_ACCOUNT || null,
    })
    if (post && url === '/twitter/oauth3/refresh') return send(200, await refreshJar())
    if (url === '/twitter/cookies') {
      let injected: any = null
      if (currentJar.auth_token) injected = await cmd('setCookies', [jarToCookies(currentJar)]).catch((e: Error) => ({ error: e.message }))
      return send(200, { injected, cookies: Object.keys(currentJar).map(n => ({ name: n, domain: '.x.com', httpOnly: HTTPONLY.has(n), value: '‹sealed in TEE›' })) })
    }
    if (url === '/twitter/probe') {
      if (!writeOk()) return send(403, { error: 'probe needs OAuth3 consent — connect X on the dashboard first' })
      const run = (c: string) => execAsync(c).then(r => r.stdout.trim()).catch((e: Error) => `ERR:${e.message}`)
      const geom = await run('xdotool getdisplaygeometry')
      const win = await run('xdotool getactivewindow getwindowname')
      const before = await run('xdotool getmouselocation --shell')
      await run('xdotool mousemove 1211 526')
      const after = await run('xdotool getmouselocation --shell')
      const winGeo = await run('xdotool getactivewindow getwindowgeometry --shell')
      return send(200, { geom, activeWindow: win, mouseBefore: before, mouseAfter: after, activeWindowGeo: winGeo })
    }
    if (url === '/twitter/ip') return send(200, await egress())
    if (post && url === '/twitter/api') {
      const b = await readBody(req)
      if (b.op !== 'timeline' && !writeOk()) return send(403, { error: `read-only: '${b.op}' writes to the account — connect X via OAuth3 to unlock writes` })
      return send(200, await runApi(b.op, b))
    }
    // Fully-headless reified engine (no browser, no xctid). Same read/write gate as the API path.
    if (post && url === '/twitter/engine') {
      const b = await readBody(req)
      if (b.op !== 'timeline' && !writeOk()) return send(403, { error: `read-only: '${b.op}' writes to the account — connect X via OAuth3 to unlock writes` })
      return send(200, await engine(b.op, b))
    }
    // Browser-driving: one at a time (never hog the single browser) + a cooldown between runs.
    // Posting is a write → also needs the secret; reads (trace/reify) are open but rate-guarded.
    const guardBrowser = () => {
      if (browserLock || activity) return send(429, { error: `browser busy${activity ? ' — ' + activity.step : ''}` }), false
      const cool = BROWSER_COOLDOWN - (Date.now() - lastBrowserRun)
      if (cool > 0) return send(429, { error: `cooling down — retry in ${Math.ceil(cool / 1000)}s` }), false
      return true
    }
    // #6: the rendered feed — replay of the browser-observed HomeTimeline, mapped to tweets+media.
    // May drive the browser to (re)capture → same single-flight lock + cooldown as reify.
    if (post && url === '/twitter/feed') {
      if (!guardBrowser()) return
      browserLock = true
      try { return send(200, await feed()) } finally { browserLock = false; lastBrowserRun = Date.now() }
    }
    // #6: same-origin media relay (the otter /frame pattern): the page never contacts twimg.com —
    // the pod fetches and streams the bytes. twimg hosts only, https only — never an open proxy.
    // Range requests pass through so <video> playback works through the relay too.
    if (url === '/twitter/media') {
      const q = new URL(req.url || '/', 'http://localhost').searchParams.get('u') || ''
      let target: URL | null = null
      try { target = new URL(Buffer.from(q, 'base64url').toString('utf8')) } catch {}
      if (!target || target.protocol !== 'https:' || !/(^|\.)twimg\.com$/.test(target.hostname))
        return send(400, { error: 'media relay: https *.twimg.com urls only' })
      const range = req.headers.range
      const r = await fetch(target, { headers: { 'user-agent': UA, referer: 'https://x.com/', ...(range ? { range } : {}) }, signal: AbortSignal.timeout(20_000) })
      const h: Record<string, string> = {
        'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
      }
      for (const k of ['content-length', 'content-range', 'accept-ranges']) { const v = r.headers.get(k); if (v) h[k] = v }
      res.writeHead(r.status, h)
      return res.end(Buffer.from(await r.arrayBuffer()))
    }
    if (post && url === '/twitter/browser') {
      const b = await readBody(req)
      if (b.task === 'post' && !writeOk()) return send(403, { error: 'read-only: posting to the account — connect X via OAuth3 to unlock writes' })
      if (!guardBrowser()) return
      browserLock = true
      try { return send(200, await runBrowser(b.task, b.text)) } finally { browserLock = false; lastBrowserRun = Date.now() }
    }
    if (post && url === '/twitter/reify') {
      if (!guardBrowser()) return
      browserLock = true
      try { return send(200, await reifyDiff()) } finally { browserLock = false; lastBrowserRun = Date.now() }
    }
    send(404, { error: 'not found' })
  } catch (e) { send(502, { error: (e as Error).message }) }
}).listen(PORT, '0.0.0.0', () => console.log(`[twitter-debug agent] :${PORT} bridge=${BRIDGE}`))

// Land the browser on x.com once it's up, so the live view is never a blank about:blank.
async function bootNav() {
  for (let i = 0; i < 30; i++) {
    try { await cmd('navigate', ['https://x.com/home']); console.log('[boot] navigated x.com'); return }
    catch { await sleep(5000) }
  }
}
bootNav()

// On boot, re-source the jar from the OAuth3 vault using the persisted token (survives restart).
async function bootJar() {
  oauthToken = await readFile(TOKEN_PATH, 'utf8').then(s => s.trim() || null).catch(() => null)
  if (!oauthToken) return console.log('[boot] no OAuth3 token — connect X on the dashboard')
  await refreshJar().then(r => console.log(`[boot] jar re-sourced from OAuth3 vault (${r.count} cookies)`)).catch(e => console.log('[boot] jar refresh failed — reconnect needed:', e.message))
}
bootJar()
