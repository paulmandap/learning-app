/**
 * Cut the starry nightcap out of the owner's Gemini picture (NOTES §72.5).
 *
 *   npx tsx scripts/cut-starry-nightcap.ts
 *
 * Reads `design-reference/Sleepy Owl in a Starry Nightcap.png` (gitignored): a
 * different owl, wearing the hat the way Nomi should. Writes, also to
 * design-reference/, `nightcap-cut.png` (the hat, see-through) and
 * `nightcap-overlay.png` (the cut in red over the picture, to check by eye).
 *
 * The blue cap is its largest blue part; the stars are what the blue encloses;
 * the cream cuff and pompom are cream that touches the hat — above the cuff's
 * bottom edge, which is fitted (a parabola) from the columns where brown
 * feathers start right under the cream, so the owl's cream face never joins.
 * Measured on 2026-10-04: 168,487 pixels, the mask exactly on the hat.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { openCanvasPage } from './chrome-canvas';

const SRC = 'design-reference/Sleepy Owl in a Starry Nightcap.png';
const OUT = 'design-reference';

const PAGE = String.raw`
const img = new Image();
img.src = SRC_URI;
await img.decode();
const W = img.naturalWidth, H = img.naturalHeight, N = W * H;
const c = document.createElement('canvas'); c.width = W; c.height = H;
const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
const data = ctx.getImageData(0, 0, W, H); const d = data.data;
const r = (i) => d[i * 4], g = (i) => d[i * 4 + 1], b = (i) => d[i * 4 + 2];
const luma = (i) => 0.299 * r(i) + 0.587 * g(i) + 0.114 * b(i);
const isPaper = (i) => Math.min(r(i), g(i), b(i)) >= 232 && r(i) - b(i) <= 16;
const isBlue = (i) => b(i) > r(i) + 10 && luma(i) < 215;
const isBrown = (i) => r(i) - b(i) > 45 && luma(i) < 175;
const isCream = (i) => !isPaper(i) && !isBlue(i) && luma(i) >= 180 && r(i) - b(i) >= 4 && r(i) - b(i) <= 75;

function flood(seeds, pass, mark) {
  const stack = seeds.slice();
  for (const s of seeds) mark[s] = 1;
  while (stack.length) {
    const i = stack.pop(); const x = i % W, y = (i - x) / W;
    const n = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
    for (const j of n) if (j >= 0 && !mark[j] && pass(j)) { mark[j] = 1; stack.push(j); }
  }
}
const border = [];
for (let x = 0; x < W; x++) { border.push(x, (H - 1) * W + x); }
for (let y = 0; y < H; y++) { border.push(y * W, y * W + W - 1); }

// Background: paper reached from the edges.
const bg = new Uint8Array(N);
flood(border.filter(isPaper), isPaper, bg);

// The blue cap: its largest blue component.
const label = new Int32Array(N).fill(-1); let best = -1, bestSize = 0, id = 0;
for (let i = 0; i < N; i++) {
  if (label[i] !== -1 || !isBlue(i)) continue;
  const mark = new Uint8Array(0); const comp = [i]; label[i] = id; let k = 0;
  while (k < comp.length) {
    const j = comp[k++]; const x = j % W, y = (j - x) / W;
    for (const q of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1]) {
      if (q >= 0 && label[q] === -1 && isBlue(q)) { label[q] = id; comp.push(q); }
    }
  }
  if (comp.length > bestSize) { bestSize = comp.length; best = id; }
  id++;
}
const hat = new Uint8Array(N);
for (let i = 0; i < N; i++) if (label[i] === best) hat[i] = 1;

// Stars: what the blue encloses — not blue, not reachable from the edges without crossing blue.
const outside = new Uint8Array(N);
flood(border.filter((i) => !hat[i]), (j) => !hat[j], outside);
let stars = 0;
for (let i = 0; i < N; i++) if (!hat[i] && !outside[i]) { hat[i] = 1; stars++; }

// The cuff's bottom edge, column by column: from the blue's lowest pixel down
// through cream, where brown starts under it.
let blueMinX = W, blueMaxX = 0;
for (let i = 0; i < N; i++) if (label[i] === best) { const x = i % W; if (x < blueMinX) blueMinX = x; if (x > blueMaxX) blueMaxX = x; }
const edge = [];
for (let x = blueMinX; x <= blueMaxX; x++) {
  let y = H - 1; while (y > 0 && label[y * W + x] !== best) y--;
  if (y <= 0) continue;
  let yy = y + 1, run = 0;
  while (yy < H && isCream(yy * W + x)) { yy++; run++; }
  // A cuff, then brown feathers within a few pixels: a trustworthy bottom edge.
  let brownBelow = false;
  for (let k = 0; k < 6 && yy + k < H; k++) if (isBrown((yy + k) * W + x)) brownBelow = true;
  if (run >= 40 && run <= 220 && brownBelow) edge.push([x, yy]);
}
// Fit y = a x^2 + b x + c to the trustworthy columns (least squares).
function fit(points) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (const [x0, y] of points) { const x = x0 / W; s0++; s1 += x; s2 += x * x; s3 += x * x * x; s4 += x * x * x * x; t0 += y; t1 += x * y; t2 += x * x * y; }
  const m = [[s4, s3, s2, t2], [s3, s2, s1, t1], [s2, s1, s0, t0]];
  for (let col = 0; col < 3; col++) {
    let p = col; for (let row = col + 1; row < 3; row++) if (Math.abs(m[row][col]) > Math.abs(m[p][col])) p = row;
    [m[col], m[p]] = [m[p], m[col]];
    for (let row = 0; row < 3; row++) if (row !== col) { const f = m[row][col] / m[col][col]; for (let k = col; k < 4; k++) m[row][k] -= f * m[col][k]; }
  }
  const a = m[0][3] / m[0][0], bq = m[1][3] / m[1][1], cq = m[2][3] / m[2][2];
  return (x) => a * (x / W) * (x / W) + bq * (x / W) + cq;
}
const bottom = edge.length >= 20 ? fit(edge) : null;

// Cream that belongs to the hat: touching the hat, and above the cuff's bottom
// edge where that edge is known (the pompom hangs past it, beside the head).
const cuffMinX = edge.length ? edge[0][0] : W, cuffMaxX = edge.length ? edge[edge.length - 1][0] : 0;
const allowed = (j) => {
  if (!isCream(j)) return false;
  const x = j % W, y = (j - x) / W;
  if (bottom && x >= cuffMinX - 30 && x <= cuffMaxX) return y <= bottom(x) + 2;
  return true;
};
const seeds = [];
for (let i = 0; i < N; i++) {
  if (hat[i] || !allowed(i)) continue;
  const x = i % W, y = (i - x) / W;
  if ((x > 0 && hat[i - 1]) || (x < W - 1 && hat[i + 1]) || (y > 0 && hat[i - W]) || (y < H - 1 && hat[i + W])) seeds.push(i);
}
const cream = new Uint8Array(N);
flood(seeds, (j) => !hat[j] && allowed(j), cream);
let creamSize = 0;
for (let i = 0; i < N; i++) if (cream[i]) { hat[i] = 1; creamSize++; }

// Close small gaps along the outline: a pixel with hat on 3+ sides, not background, joins.
for (let pass = 0; pass < 2; pass++) {
  const add = [];
  for (let i = 0; i < N; i++) {
    if (hat[i] || bg[i]) continue;
    const x = i % W, y = (i - x) / W;
    let k = 0; if (x > 0 && hat[i - 1]) k++; if (x < W - 1 && hat[i + 1]) k++; if (y > 0 && hat[i - W]) k++; if (y < H - 1 && hat[i + W]) k++;
    if (k >= 3) add.push(i);
  }
  for (const i of add) hat[i] = 1;
}

// Bounding box, the cut, and an overlay to check by eye.
let x0 = W, y0 = H, x1 = 0, y1 = 0, total = 0;
for (let i = 0; i < N; i++) if (hat[i]) { const x = i % W, y = (i - x) / W; total++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
const out = ctx.createImageData(W, H);
for (let i = 0; i < N; i++) { if (!hat[i]) continue; out.data[i * 4] = r(i); out.data[i * 4 + 1] = g(i); out.data[i * 4 + 2] = b(i); out.data[i * 4 + 3] = 255; }
const cut = document.createElement('canvas'); cut.width = x1 - x0 + 5; cut.height = y1 - y0 + 5;
const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; tmp.getContext('2d').putImageData(out, 0, 0);
cut.getContext('2d').drawImage(tmp, x0 - 2, y0 - 2, cut.width, cut.height, 0, 0, cut.width, cut.height);
const ov = ctx.getImageData(0, 0, W, H);
for (let i = 0; i < N; i++) if (hat[i]) { ov.data[i * 4] = Math.min(255, ov.data[i * 4] * 0.5 + 128); ov.data[i * 4 + 1] *= 0.5; ov.data[i * 4 + 2] *= 0.5; }
const oc = document.createElement('canvas'); oc.width = W; oc.height = H; oc.getContext('2d').putImageData(ov, 0, 0);
const small = document.createElement('canvas'); small.width = W / 2; small.height = H / 2;
small.getContext('2d').drawImage(oc, 0, 0, W / 2, H / 2);
return {
  size: [W, H], blue: bestSize, stars, edgeColumns: edge.length, cuffSpan: [cuffMinX, cuffMaxX], cream: creamSize, total,
  box: [x0, y0, x1, y1],
  cut: cut.toDataURL('image/png'), overlay: small.toDataURL('image/png'),
};
`;

async function main() {
  const uri = `data:image/png;base64,${readFileSync(SRC).toString('base64')}`;
  const page = await openCanvasPage('starry-hat');
  try {
    const res = await page.evaluate<Record<string, unknown> & { cut: string; overlay: string }>(
      `(async () => { const SRC_URI = ${JSON.stringify(uri)}; ${PAGE} })()`,
    );
    writeFileSync(`${OUT}/nightcap-cut.png`, Buffer.from(res.cut.split(',')[1]!, 'base64'));
    writeFileSync(`${OUT}/nightcap-overlay.png`, Buffer.from(res.overlay.split(',')[1]!, 'base64'));
    const { cut: _c, overlay: _o, ...facts } = res;
    console.log(JSON.stringify(facts));
  } finally {
    await page.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
