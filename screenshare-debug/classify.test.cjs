// classify.test.cjs — verifies the SHIPPED change-detect logic (extracted verbatim from
// public/index.html) classifies the synthetic source correctly. No canvas/browser needed:
// frames are generated as grayscale Uint8Arrays matching what drawSynth() paints.
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found in index.html');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

// constants verbatim from index.html
const W = 200, H = 125, PX = W * H, COLS = 20, ROWS = 12, TW = 10, TH = 10;

// pull the shipped functions out of the HTML and define them in this scope
// constants verbatim from index.html (the fns close over them there)
const consts = `const W=200,H=125,PX=W*H,COLS=20,ROWS=12,TW=10,TH=10;const PIXEL_THRESH=26,TILE_THRESH=12,SCENE_AREA_FRAC=0.30;`;
const code = `${consts}
${extractFn(html, 'diffFrame')}
${extractFn(html, 'boxes')}
${extractFn(html, 'classify')}
module.exports = { diffFrame, boxes, classify };
`;
const tmp = path.join(require('os').tmpdir(), 'ss71-fns.cjs');
fs.writeFileSync(tmp, code);
const { diffFrame, boxes, classify } = require(tmp);

// frame builders matching drawSynth's pixels (luma = (r*77+g*150+b*29)>>8)
const BG = 14;        // #0c0f12 background luma
const RECT = 200;     // bright moving-rect luma (>> PIXEL_THRESH)
const SWAP_A = 138;   // #ff48b0 (even frames)
const SWAP_B = 92;    // #00838a (odd frames)
function blank(v) { const g = new Uint8Array(PX); g.fill(v); return g; }
function rectAt(v, x, y, rw, rh, col) {
  const g = blank(v);
  for (let yy = y; yy < y + rh && yy < H; yy++) for (let xx = x; xx < x + rw && xx < W; xx++) g[yy * W + xx] = col;
  return g;
}
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } console.log('PASS: ' + msg); }

// 1. static period → still (two identical frozen frames)
{
  const f = rectAt(BG, 58, 38, 64, 44, 70); // the "static · still" source frame
  const d = diffFrame(f, f);
  const bx = boxes(d.hot);
  const k = classify(d.hot, bx);
  assert(k === 'still', 'static period → class=still (no hot tiles, no POST)');
  assert(bx.length === 0, 'still → zero bounding boxes');
}

// 2. moving rect → local, with bounding boxes covering the movement
{
  const prevP = rectAt(BG, 20, 20, 42, 30, RECT);   // rect was here
  const curP  = rectAt(BG, 140, 80, 42, 30, RECT);  // …now here (bg refilled at old spot)
  const d = diffFrame(prevP, curP);
  const bx = boxes(d.hot);
  const k = classify(d.hot, bx);
  assert(k === 'local', 'moving rect → class=local (hot tiles, area < 30%)');
  assert(bx.length >= 1, 'local → ≥1 bounding box overlay');
  const area = bx.reduce((a, b) => a + b.w * b.h, 0);
  assert(area > 0 && area / PX < 0.30, 'local → box area covers movement but < 30% of frame (' + (area / PX * 100).toFixed(1) + '%)');
  assert(d.changedPct > 0, 'local → changedPct > 0 (' + d.changedPct.toFixed(2) + '%)');
}

// 3. color swap → scene (full-frame change every frame)
{
  const a = blank(SWAP_A), b = blank(SWAP_B);
  const d = diffFrame(a, b);
  const bx = boxes(d.hot);
  const k = classify(d.hot, bx);
  assert(k === 'scene', 'color swap → class=scene (most tiles hot)');
  let hotN = 0; for (let i = 0; i < d.hot.length; i++) if (d.hot[i]) hotN++;
  assert(hotN / (COLS * ROWS) > 0.5, 'scene → >50% tiles hot (' + (hotN / (COLS * ROWS) * 100).toFixed(0) + '%)');
  assert(d.changedPct > 90, 'scene → changedPct > 90% (' + d.changedPct.toFixed(1) + '%)');
}

// 4. bootstrap: identical prev/cur (treated as no-change) → still, proving no false sends on idle
{
  const f = blank(BG);
  const d = diffFrame(f, f);
  assert(classify(d.hot, boxes(d.hot)) === 'still', 'identical frames → still (POST skipped)');
}

console.log('\nALL CLASSIFIER ASSERTIONS PASSED');
