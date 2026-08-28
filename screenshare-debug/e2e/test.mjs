// #70 acceptance, checkbox 3: drive the deployed-shaped recorder page with REAL capture —
// headful chromium under Xvfb, screen picker auto-resolved by launch flags — then check the
// sink: empty for the session before Upload, kept frames listed after, deleted frame absent,
// and a decoded JPEG that is uniformly black inside the blackout rect. Exits 0 only if all hold.
import { chromium } from "playwright-core";
import jpeg from "jpeg-js";

const SINK = process.env.SINK_URL || "http://sink:8080";
const APP = `${SINK}/screenshare-debug/`;
const shot = async (page, name) => { await page.screenshot({ path: `/out/${name}.png` }); console.log(`shot: ${name}.png`); };
const assert = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok: ${msg}`); };

// wait for the sink (compose starts both at once)
let health = null;
for (let i = 0; i < 60 && !health; i++) {
  try { health = await fetch(`${APP}health`).then((r) => r.json()); } catch (_) { await new Promise((r) => setTimeout(r, 1000)); }
}
assert(health && health.ok, `sink healthy at ${APP} (build ${health && health.build})`);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: false, // headful under Xvfb — the capture source is the virtual display
  args: [
    "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1200,900",
    // auto-select resolves the picker by itself. --use-fake-ui-for-media-stream was tried WITH
    // it and breaks capture in chromium 151 (NotReadableError: could not start video source) —
    // verified by flag-matrix run; leaving it off is what makes real capture work here.
    '--auto-select-desktop-capture-source=Entire screen',
    `--unsafely-treat-insecure-origin-as-secure=${SINK}`, // http://sink isn't a secure context; mediaDevices needs one
  ],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));

try {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("build").textContent !== "…");
  await page.fill("#interval", "0.5");

  // ── record: Start → picker auto-resolves → Stop bounds one session ──
  try {
    await page.click("#start");
    await page.waitForFunction(() => /(\d+) kept$/.test(document.getElementById("prevCap").textContent), null, { timeout: 15000 });
  } catch (e) {
    const state = {};
    for (const id of ["statusTxt", "errTxt", "prevCap", "rateTxt"]) state[id] = await page.textContent("#" + id).catch(() => "?");
    throw new Error(`record phase failed — page state: ${JSON.stringify(state)} :: ${e.message}`);
  }
  await page.waitForFunction(() => Number(document.getElementById("prevCap").textContent.match(/(\d+) kept$/)?.[1] || 0) >= 3, null, { timeout: 20000 });
  await page.click("#stop");
  await page.waitForSelector("#reviewCard:not([hidden])");

  const sid = (await page.textContent("#sid")).trim();
  assert(/^s-[a-z0-9]{6,12}$/.test(sid), `session id shown: ${sid}`);
  const stripN = await page.locator("#strip img").count();
  assert(stripN >= 3, `filmstrip shows ${stripN} frames`);
  assert(await page.locator("#note").count() === 1, "freeform note field shown");

  // ── nothing has left the browser: the sink lists NOTHING for this session ──
  const before = await fetch(`${APP}sink/frames`).then((r) => r.json());
  assert(!before.some((f) => f.sid === sid), `GET /sink/frames lists nothing for ${sid} before upload`);
  await shot(page, "01-review");

  // ── review: delete one kept frame, black out a region of frame #1, note, upload ──
  const del = page.locator("#strip [data-del]").nth(1); // second kept frame (frame #1 keeps its seq)
  const delSeq = Number(await del.getAttribute("data-del"));
  await del.click();
  await page.locator("#strip img").first().click(); // enlarge frame #1
  await page.waitForSelector("#frameWrap:not([hidden])");
  await page.locator("#rects").scrollIntoViewIfNeeded(); // enlarged frame starts below the fold
  const box = await page.locator("#rects").boundingBox();
  const a = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.25 };
  const b = { x: box.x + box.width * 0.72, y: box.y + box.height * 0.7 };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  const rectLbl = (await page.textContent("#rectList")).trim();
  assert(/^rect 0:/.test(rectLbl), `blackout rect drawn (${rectLbl})`);
  const [, rx, ry, rw, rh] = rectLbl.match(/rect 0: (\d+),(\d+) (\d+)×(\d+)/).map(Number);

  await page.fill("#note", "e2e compose run — reproduce the flaky save");
  await page.click("#upload");
  await page.waitForSelector("#doneCard:not([hidden])", { timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll("#upRows td")].length > 0 &&
    [...document.querySelectorAll("#upRows tr")].every((tr) => tr.textContent.includes("yes")), null, { timeout: 30000 });
  await shot(page, "02-uploaded");

  // ── the sink: kept frames listed under the session, deleted frame absent ──
  const after = await fetch(`${APP}sink/frames`).then((r) => r.json());
  const mine = after.filter((f) => f.sid === sid);
  const seqs = mine.map((f) => f.seq).sort((x, y) => x - y);
  assert(mine.length >= 2, `GET /sink/frames lists ${mine.length} kept frames under ${sid}`);
  assert(!seqs.includes(delSeq), `deleted frame #${delSeq} absent from the listing`);
  assert(seqs.includes(1), "frame #1 present");

  // ── pixel check: decoded JPEG is uniformly black inside the rect, not outside ──
  const jpg = Buffer.from(await fetch(`${APP}sink/frame/${sid}/1.jpg`).then((r) => r.arrayBuffer()));
  const img = jpeg.decode(jpg, { useTArray: true });
  const luma = (x, y) => { const i = (y * img.width + x) * 4; return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]; };
  const mx = 0.08; // JPEG ringing margin: sample the rect's interior
  let black = 0, tot = 0, worst = 0;
  for (let y = Math.round(ry + rh * mx); y < ry + rh * (1 - mx); y += 2) {
    for (let x = Math.round(rx + rw * mx); x < rx + rw * (1 - mx); x += 2) {
      tot++; const l = luma(x, y); worst = Math.max(worst, l); if (l <= 6) black++;
    }
  }
  assert(tot > 0 && black === tot, `rect interior uniformly black (${black}/${tot} px, worst luma ${worst.toFixed(1)}) — decoded, not eyeballed`);
  let bright = 0;
  for (let y = 0; y < img.height; y += 4) for (let x = 0; x < img.width; x += 4) if (luma(x, y) > 30) bright++;
  assert(bright > 50, `frame is not blank outside the rect (${bright} bright samples)`);

  // ── dev side: session list → filmstrip → per-frame metadata, deleted frame absent ──
  await page.click("#devSide summary");
  await page.waitForSelector("#devBody .sess");
  const devSess = await page.locator("#devBody .sess").first().textContent();
  assert(devSess.includes(sid), `dev side lists ${sid}`);
  await page.click("#devBody [data-open]");
  await page.waitForSelector(`#dev-${sid} img`);
  const devImgs = await page.locator(`#dev-${sid} img`).count();
  assert(devImgs === mine.length, `dev filmstrip shows ${devImgs} frames (deleted #${delSeq} absent)`);
  await shot(page, "03-devside");

  console.log(`\nPASS — ${sid}: recorded ${stripN} frames, deleted #${delSeq}, redacted #1, uploaded ${mine.length}; rect black; sink verified.`);
  await browser.close();
  process.exit(0);
} catch (e) {
  await shot(page, "99-fail").catch(() => {});
  console.error(String((e && e.message) || e));
  await browser.close();
  process.exit(1);
}
