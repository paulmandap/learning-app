/**
 * Cut Nomi's canonical pose into the layers the character is animated from.
 *
 *   npx tsx scripts/make-nomi-assets.ts
 *   npx tsx scripts/make-nomi-assets.ts <sheet.png> --debug <dir>
 *
 * Reads the character reference sheet from `design-reference/` (gitignored —
 * reference material, not an app asset) and writes four same-size, transparent
 * WebP layers to `assets/`:
 *
 *   nomi-body.webp        everything that does not move on its own
 *   nomi-wing-left.webp   rotates about the shoulder
 *   nomi-wing-right.webp
 *   nomi-eyes.webp        both irises; squashed to blink, shifted to look
 *
 * And writes the rig — pivots and the eye line, as fractions of the layer size
 * — to `src/ui/nomi-rig.ts`, in the same run. The numbers describe those exact
 * images, so they are only ever written together; a rig typed in by hand would
 * be one re-cut away from wings that pivot about thin air.
 *
 * ## Why layers cut from ONE pose, not the eight poses on the sheet
 *
 * The sheet draws each state as a separate illustration, and they do not line
 * up: the owl is a different size and sits in a different place in every cell.
 * Cross-fading between them ghosts, for the same reason the pet's five stages
 * had to come from one generated image (NOTES §17.5). Parts of a single pose
 * move without ever changing what the owl is.
 *
 * ## The one hard part: what is BEHIND a wing
 *
 * The art is flat. Where a wing overlaps the body there is no body underneath
 * it, so a wing that lifts would uncover a hole. Two facts make it fillable:
 *
 *  - **The body's edge under a wing is predictable.** The owl is one egg, head
 *    and body together, visible above and below each wing — so one ellipse,
 *    fitted to BOTH sides at once, says where the silhouette runs in between.
 *    A quadratic per side was tried first and was wrong in a way worth
 *    recording: fitted mostly to the head, it curved the body INWARD below the
 *    shoulder, and the owl under its wings came out as a box.
 *  - **The body is nearly one colour there.** Sampled on the sheet: body side
 *    166,108,71 and wing 150,96,61. So each row is filled with the body colour
 *    measured just inside the wing's inner edge, and the seam is invisible.
 *
 * The wing outlines are hand-placed polygons, read off a 4× gridded crop.
 * Deliberately loose on the body side: a polygon a pixel too wide carries a
 * sliver of near-identical body colour with the wing, while one a pixel too
 * tight leaves a sliver of WING painted on the body — a second wing edge that
 * appears the moment the real one lifts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCanvasPage } from './chrome-canvas';

type Point = [number, number];

/**
 * Where everything is, in pixels of FRAME (origin at the frame's top-left).
 *
 * Measured from `design-reference/nomi-different-interactions.png`, 1697×927.
 * Regenerating the sheet at another size or layout invalidates every number
 * here, which is why they are named rather than inlined in the page code.
 */
const CONFIG = {
  /** The canonical pose, clear of the "CANONICAL POSE" labels above and below. */
  frame: { x: 680, y: 88, w: 320, h: 392 },

  /**
   * Paper, and the ground shadow drawn on it. Both are pale and nearly neutral;
   * the belly (228,196,162) and the face (251,233,208) are warmer than this
   * allows, and are enclosed by the body anyway, so a flood from the edge can
   * never reach them.
   */
  paperMinLuma: 200,
  paperMaxWarmth: 40,

  /** Pixels this close to the paper get their alpha estimated, not copied. */
  edgeBand: 3,

  wings: {
    left: {
      points: [
        [34, 181], [44, 185], [52, 195], [58, 210], [62, 225], [64, 240], [64, 262],
        [64, 285], [60, 302], [56, 316], [49, 326], [38, 327], [26, 314], [13, 296],
        [6, 282], [2, 255], [3, 232], [10, 206], [21, 189],
      ] as Point[],
      pivot: [40, 194] as Point,
    },
    right: {
      points: [
        [283, 181], [295, 187], [304, 197], [311, 220], [317, 245], [315, 270], [310, 285],
        [303, 299], [295, 311], [286, 320], [275, 327], [263, 324], [258, 310], [254, 295],
        [253, 270], [252, 240], [254, 215], [260, 200], [270, 187],
      ] as Point[],
      pivot: [278, 194] as Point,
    },
  },

  /**
   * Rows where the body's own edge is visible, above and below the wings. The
   * lower range stops above the feet, which sit inside the silhouette anyway.
   */
  bodyFitRows: [[112, 176], [330, 344]] as Point[],

  /** Iris edge: the first pixels paler than this, walking out from the pupil. */
  irisMaxLuma: 215,
  /** Added to each measured iris radius, for the reason given on `eyes`. */
  eyeMargin: 1.25,

  /** Body colour is sampled this many pixels inside a wing's inner edge. */
  fillSampleFrom: 2,
  fillSampleTo: 5,

  /**
   * Starting guesses for the irises; the page measures the real centre and
   * radius from the pixels. Hand estimates were a pixel or so out, and that
   * was enough to leave a faint brown circle on the face behind each eye.
   *
   * Generous on purpose: a radius a little too large takes a sliver of the
   * cream face with the eye, which is invisible against the cream it squashes
   * over; too small leaves a brown ring on the face during every blink.
   */
  eyes: [
    { cx: 100.6, cy: 131.8 },
    { cx: 215.6, cy: 131.0 },
  ],
  eyeFeather: 1.5,
  /** The face colour behind an eye is read on a ring this far outside it. */
  ringOffset: 6,

  quality: 0.92,
};

/**
 * The page-side work. Plain JavaScript in a string, like `make-pet-assets.ts`:
 * it runs in Chrome, not in Node, and has no access to anything above.
 * No template literals inside it, so nothing is accidentally interpolated.
 */
const PAGE = String.raw`
const img = new Image();
img.src = cfg.dataUri;
await img.decode();

const F = cfg.frame, W = F.w, H = F.h, N = W * H;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

const srcC = makeCanvas(W, H);
const sg = srcC.getContext('2d', { willReadFrequently: true });
sg.drawImage(img, -F.x, -F.y);
const d = sg.getImageData(0, 0, W, H).data;
const lumaAt = (p) => 0.3 * d[p * 4] + 0.59 * d[p * 4 + 1] + 0.11 * d[p * 4 + 2];

// 1. Paper: flood inwards from the frame edge through pale, neutral pixels.
const paper = new Uint8Array(N);
const isPaper = (p) => lumaAt(p) >= cfg.paperMinLuma && d[p * 4] - d[p * 4 + 2] <= cfg.paperMaxWarmth;
{
  const stack = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const p = stack.pop();
    if (paper[p] || !isPaper(p)) continue;
    paper[p] = 1;
    const x = p % W, y = (p - x) / W;
    if (x > 0) stack.push(p - 1);
    if (x < W - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - W);
    if (y < H - 1) stack.push(p + W);
  }
}
let bgR = 0, bgG = 0, bgB = 0, bgN = 0;
for (let p = 0; p < N; p++) {
  if (paper[p] && lumaAt(p) > 235) { bgR += d[p * 4]; bgG += d[p * 4 + 1]; bgB += d[p * 4 + 2]; bgN++; }
}
const bg = [bgR / bgN, bgG / bgN, bgB / bgN];

// 2. The largest remaining piece is the owl. Label fragments and sparkles are not.
const comp = new Int32Array(N).fill(-1);
let best = -1, bestSize = 0, nextComp = 0;
for (let s = 0; s < N; s++) {
  if (paper[s] || comp[s] !== -1) continue;
  let size = 0;
  const st = [s];
  comp[s] = nextComp;
  while (st.length) {
    const p = st.pop();
    size++;
    const x = p % W, y = (p - x) / W;
    const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
    for (const q of nb) if (q >= 0 && !paper[q] && comp[q] === -1) { comp[q] = nextComp; st.push(q); }
  }
  if (size > bestSize) { bestSize = size; best = nextComp; }
  nextComp++;
}
const inOwl = (p) => comp[p] === best;

// 3. Distance from outside the owl (3-4 chamfer), for the edge band.
const dist = new Float32Array(N);
for (let p = 0; p < N; p++) dist[p] = inOwl(p) ? 1e9 : 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const p = y * W + x; if (!dist[p]) continue;
  let v = dist[p];
  v = Math.min(v, x > 0 ? dist[p - 1] + 3 : 3, y > 0 ? dist[p - W] + 3 : 3);
  v = Math.min(v, x > 0 && y > 0 ? dist[p - W - 1] + 4 : 4, x < W - 1 && y > 0 ? dist[p - W + 1] + 4 : 4);
  dist[p] = v;
}
for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
  const p = y * W + x; if (!dist[p]) continue;
  let v = dist[p];
  v = Math.min(v, x < W - 1 ? dist[p + 1] + 3 : 3, y < H - 1 ? dist[p + W] + 3 : 3);
  v = Math.min(v, x < W - 1 && y < H - 1 ? dist[p + W + 1] + 4 : 4, x > 0 && y < H - 1 ? dist[p + W - 1] + 4 : 4);
  dist[p] = v;
}
for (let p = 0; p < N; p++) dist[p] /= 3;

// 4. The owl as straight RGB + alpha 0..1. Edge pixels take the colour just
//    inside them and an alpha from how far they sit between paper and that
//    colour — so the paper does not come along as a pale fringe on dark mode.
const owl = new Float32Array(N * 4);
for (let p = 0; p < N; p++) {
  if (!inOwl(p)) continue;
  const q = p * 4;
  if (dist[p] >= cfg.edgeBand) { owl[q] = d[q]; owl[q + 1] = d[q + 1]; owl[q + 2] = d[q + 2]; owl[q + 3] = 1; continue; }
  const x = p % W, y = (p - x) / W;
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    const pp = yy * W + xx;
    if (!inOwl(pp) || dist[pp] < cfg.edgeBand) continue;
    r += d[pp * 4]; g += d[pp * 4 + 1]; b += d[pp * 4 + 2]; n++;
  }
  if (!n) { r = d[q]; g = d[q + 1]; b = d[q + 2]; n = 1; }
  const inner = [r / n, g / n, b / n];
  const u = [inner[0] - bg[0], inner[1] - bg[1], inner[2] - bg[2]];
  const v = [d[q] - bg[0], d[q + 1] - bg[1], d[q + 2] - bg[2]];
  const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
  const alpha = uu > 0 ? clamp((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / uu, 0, 1) : 1;
  owl[q] = inner[0]; owl[q + 1] = inner[1]; owl[q + 2] = inner[2]; owl[q + 3] = alpha < 0.08 ? 0 : alpha;
}

// 5. Wings.
function coverage(points) {
  const c = makeCanvas(W, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.beginPath();
  points.forEach((pt, i) => (i ? g.lineTo(pt[0], pt[1]) : g.moveTo(pt[0], pt[1])));
  g.closePath();
  g.fill();
  const m = g.getImageData(0, 0, W, H).data;
  const out = new Float32Array(N);
  for (let p = 0; p < N; p++) out[p] = m[p * 4 + 3] / 255;
  return out;
}

/** Silhouette edges of one row, at half coverage. */
function rowEdges(y) {
  let left = -1, right = -1;
  for (let x = 0; x < W; x++) if (owl[(y * W + x) * 4 + 3] >= 0.5) { left = x; break; }
  for (let x = W - 1; x >= 0; x--) if (owl[(y * W + x) * 4 + 3] >= 0.5) { right = x; break; }
  return [left, right];
}

/** Solve a small linear system by Gaussian elimination with partial pivoting. */
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => row.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    const tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * The owl's outline as one axis-aligned ellipse, fitted to both sides at once.
 *
 * The axis is the mean of left and right edges, which holds the fit
 * symmetric. An ellipse's squared half-width is a quadratic in y —
 * dx² = a0 + a1·y + a2·y², with a2 < 0 — so this is ordinary least squares on
 * dx², with no iteration and nothing to converge.
 *
 * NOT "dx²·P + y²·Q + y·S + T = 1", which was the first version: that system
 * has the trivial solution P = Q = S = 0, T = 1, which fits every row exactly
 * and describes nothing. It returned NaN for every row, and because NaN fails
 * every comparison, the at-rest check reported success over pixels it had
 * silently skipped.
 */
function bodyFit(rowRanges) {
  const rows = [];
  for (const range of rowRanges) for (let y = range[0]; y <= range[1]; y++) {
    const e = rowEdges(y);
    if (e[0] >= 0 && e[1] >= 0) rows.push({ y, left: e[0] + 0.5, right: e[1] + 0.5 });
  }
  const cx = rows.reduce((s, r) => s + (r.left + r.right) / 2, 0) / rows.length;
  const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Atb = [0, 0, 0];
  for (const r of rows) for (const x of [r.left, r.right]) {
    const v = [1, r.y, r.y * r.y], target = (x - cx) * (x - cx);
    for (let i = 0; i < 3; i++) { Atb[i] += v[i] * target; for (let j = 0; j < 3; j++) AtA[i][j] += v[i] * v[j]; }
  }
  const [a0, a1, a2] = solve(AtA, Atb);
  if (!(a2 < 0) || !Number.isFinite(a0 + a1 + a2)) throw new Error('outline fit is not an ellipse: ' + [a0, a1, a2].join(', '));
  const half = (y) => Math.sqrt(Math.max(0, a0 + a1 * y + a2 * y * y));
  let worst = 0;
  for (const r of rows) worst = Math.max(worst, Math.abs(cx - half(r.y) - r.left), Math.abs(cx + half(r.y) - r.right));
  return { cx, half, left: (y) => cx - half(y), right: (y) => cx + half(y), samples: rows.length, worstResidual: worst };
}

/** Per row, the body colour just inside the wing's inner edge. */
function rowFill(mask, side) {
  const cols = new Array(H).fill(null);
  for (let y = 0; y < H; y++) {
    let inner = -1;
    if (side === 'left') { for (let x = W - 1; x >= 0; x--) if (mask[y * W + x] > 0.01) { inner = x; break; } }
    else { for (let x = 0; x < W; x++) if (mask[y * W + x] > 0.01) { inner = x; break; } }
    if (inner < 0) continue;
    let r = 0, g = 0, b = 0, n = 0;
    for (let k = cfg.fillSampleFrom; k <= cfg.fillSampleTo; k++) {
      const x = side === 'left' ? inner + k : inner - k;
      if (x < 0 || x >= W) continue;
      const q = (y * W + x) * 4;
      if (owl[q + 3] < 1) continue;
      r += owl[q]; g += owl[q + 1]; b += owl[q + 2]; n++;
    }
    if (n) cols[y] = [r / n, g / n, b / n];
  }
  // Rows with no body beside them borrow the nearest row that had some.
  const known = cols.map((c, y) => (c ? y : -1)).filter((y) => y >= 0);
  for (let y = 0; y < H; y++) {
    if (cols[y] || !known.length) continue;
    let near = known[0];
    for (const k of known) if (Math.abs(k - y) < Math.abs(near - y)) near = k;
    cols[y] = cols[near];
  }
  // Smoothed down the rows, so no single row can band.
  const out = new Array(H);
  for (let y = 0; y < H; y++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let k = -3; k <= 3; k++) { const c = cols[y + k]; if (c) { r += c[0]; g += c[1]; b += c[2]; n++; } }
    out[y] = n ? [r / n, g / n, b / n] : [0, 0, 0];
  }
  return out;
}

const body = new Float32Array(owl);
const layers = { wingLeft: new Float32Array(N * 4), wingRight: new Float32Array(N * 4), eyes: new Float32Array(N * 4) };
const report = {};

const outline = bodyFit(cfg.bodyFitRows);
report.outline = { cx: outline.cx, samples: outline.samples, worstResidual: outline.worstResidual, profile: [] };
for (let y = 104; y <= 352; y += 12) {
  const e = rowEdges(y);
  report.outline.profile.push([y, e[0], Math.round(outline.left(y) * 10) / 10, e[1], Math.round(outline.right(y) * 10) / 10]);
}

for (const side of ['left', 'right']) {
  const spec = cfg.wings[side];
  const mask = coverage(spec.points);
  const fill = rowFill(mask, side);
  const wing = side === 'left' ? layers.wingLeft : layers.wingRight;
  for (let p = 0; p < N; p++) {
    const m = mask[p];
    if (m <= 0) continue;
    const q = p * 4, x = p % W, y = (p - x) / W;
    wing[q] = owl[q]; wing[q + 1] = owl[q + 1]; wing[q + 2] = owl[q + 2]; wing[q + 3] = owl[q + 3] * m;
    const inside = side === 'left' ? clamp(x + 0.5 - outline.left(y), 0, 1) : clamp(outline.right(y) - x + 0.5, 0, 1);
    const f = fill[y];

    // A pixel on the polygon's own antialiased edge, where the owl is opaque:
    // split it EXACTLY rather than blending. Blending left the wing's dark
    // inner shadow mixed into the fill, 8-12 off at rest along every inner
    // edge; and where the fitted body edge also crossed the pixel, it left the
    // owl translucent there. So the body stays opaque under a part-covered
    // pixel, whatever the fit says — the fit only decides where the wing is
    // SOLID and the body behind it has to end.
    if (owl[q + 3] >= 0.999 && m < 1) {
      // Mostly body: leave the body as drawn; the wing adds its share of the
      // same colour, so m·O + (1 − m)·O = O.
      if (m < 0.5) continue;
      // Mostly wing: the body under it is the fill, and the wing takes the
      // colour that makes m·wing + (1 − m)·fill come back to the original.
      for (let ch = 0; ch < 3; ch++) wing[q + ch] = clamp((owl[q + ch] - (1 - m) * f[ch]) / m, 0, 255);
      body[q] = f[0]; body[q + 1] = f[1]; body[q + 2] = f[2]; body[q + 3] = 1;
      continue;
    }
    const aOld = owl[q + 3] * (1 - m), aNew = inside * m, a = aOld + aNew;
    if (a <= 0) { body[q] = 0; body[q + 1] = 0; body[q + 2] = 0; body[q + 3] = 0; continue; }
    body[q] = (owl[q] * aOld + f[0] * aNew) / a;
    body[q + 1] = (owl[q + 1] * aOld + f[1] * aNew) / a;
    body[q + 2] = (owl[q + 2] * aOld + f[2] * aNew) / a;
    body[q + 3] = a;
  }
}

// 6. Eyes, and the face behind them.
function sampleOwl(x, y) {
  const x0 = clamp(Math.floor(x), 0, W - 2), y0 = clamp(Math.floor(y), 0, H - 2);
  const fx = clamp(x - x0, 0, 1), fy = clamp(y - y0, 0, 1);
  const out = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const v00 = owl[(y0 * W + x0) * 4 + ch], v10 = owl[(y0 * W + x0 + 1) * 4 + ch];
    const v01 = owl[((y0 + 1) * W + x0) * 4 + ch], v11 = owl[((y0 + 1) * W + x0 + 1) * 4 + ch];
    out[ch] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  }
  return out;
}
/**
 * The real centre and radius of an iris, from where the pupil's darkness ends.
 *
 * Rays start 22px out, past the white highlight, which sits inside the pupil
 * and would otherwise read as the iris ending early. Opposite rays re-centre
 * the estimate: if the left ray is longer than the right, the centre is left.
 */
function measureEye(guess) {
  let cx = guess.cx, cy = guess.cy, radius = 0;
  const RAYS = 72;
  for (let pass = 0; pass < 3; pass++) {
    const len = [];
    for (let k = 0; k < RAYS; k++) {
      const t = (k / RAYS) * Math.PI * 2;
      let r = 22;
      for (; r < 60; r += 0.25) {
        const s = sampleOwl(cx + r * Math.cos(t), cy + r * Math.sin(t));
        if (0.3 * s[0] + 0.59 * s[1] + 0.11 * s[2] > cfg.irisMaxLuma) break;
      }
      len.push(r);
    }
    let dx = 0, dy = 0;
    for (let k = 0; k < RAYS / 2; k++) {
      const t = (k / RAYS) * Math.PI * 2, shift = (len[k] - len[k + RAYS / 2]) / 2;
      dx += (shift * Math.cos(t)) / (RAYS / 2) * 2; dy += (shift * Math.sin(t)) / (RAYS / 2) * 2;
    }
    cx += dx; cy += dy;
    const sorted = len.slice().sort((a, b) => a - b);
    radius = sorted[Math.floor(RAYS * 0.9)];
  }
  return { cx, cy, r: radius + cfg.eyeMargin };
}
const eyes = cfg.eyes.map(measureEye);
report.eyes = eyes.map((e) => ({ cx: Math.round(e.cx * 10) / 10, cy: Math.round(e.cy * 10) / 10, r: Math.round(e.r * 10) / 10 }));

for (const e of eyes) {
  const ringR = e.r + cfg.ringOffset;
  for (let y = Math.floor(e.cy - e.r - 4); y <= Math.ceil(e.cy + e.r + 4); y++) {
    for (let x = Math.floor(e.cx - e.r - 4); x <= Math.ceil(e.cx + e.r + 4); x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const dd = Math.hypot(x + 0.5 - e.cx, y + 0.5 - e.cy);
      const cov = clamp((e.r + cfg.eyeFeather - dd) / cfg.eyeFeather, 0, 1);
      if (cov <= 0) continue;
      const q = (y * W + x) * 4;
      layers.eyes[q] = owl[q]; layers.eyes[q + 1] = owl[q + 1]; layers.eyes[q + 2] = owl[q + 2];
      layers.eyes[q + 3] = owl[q + 3] * cov;
      // Mostly face: leave the face as drawn — the eye's share is the same colour.
      if (cov < 0.5) continue;
      const theta = Math.atan2(y + 0.5 - e.cy, x + 0.5 - e.cx);
      const ring = [0, 0, 0];
      for (let k = -2; k <= 2; k++) {
        const t = theta + k * 0.12;
        const s = sampleOwl(e.cx + ringR * Math.cos(t), e.cy + ringR * Math.sin(t));
        ring[0] += s[0] / 5; ring[1] += s[1] / 5; ring[2] += s[2] / 5;
      }
      // Mostly eye: the face behind is the ring colour, and the eye takes the
      // colour that makes cov·eye + (1 − cov)·ring come back to the original.
      for (let ch = 0; ch < 3; ch++) {
        if (cov < 1) layers.eyes[q + ch] = clamp((owl[q + ch] - (1 - cov) * ring[ch]) / cov, 0, 255);
        body[q + ch] = ring[ch];
      }
    }
  }
}

// 7. At rest the layers must reproduce the owl. Measured, not assumed.
//
// Non-finite values first, and loudly. NaN fails every comparison, so a layer
// full of it sails through a "worst difference" check as a pass — which is
// exactly what the first, degenerate outline fit did.
for (const [name, arr] of [['body', body], ['wingLeft', layers.wingLeft], ['wingRight', layers.wingRight], ['eyes', layers.eyes]]) {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) throw new Error(name + ' has a non-finite value at pixel ' + Math.floor(i / 4) + ' — something upstream divided by zero');
  }
}
{
  let worst = 0, over8 = 0, counted = 0;
  const where = [];
  const over = (top, under) => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (a <= 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((ch) => (top[ch] * top[3] + under[ch] * under[3] * (1 - top[3])) / a).concat([a]);
  };
  const px = (arr, q) => [arr[q], arr[q + 1], arr[q + 2], arr[q + 3]];
  for (let p = 0; p < N; p++) {
    const q = p * 4;
    if (owl[q + 3] < 0.99) continue;
    let c = px(body, q);
    c = over(px(layers.wingLeft, q), c);
    c = over(px(layers.wingRight, q), c);
    c = over(px(layers.eyes, q), c);
    const diff = Math.max(Math.abs(c[0] - owl[q]), Math.abs(c[1] - owl[q + 1]), Math.abs(c[2] - owl[q + 2]), 255 * Math.abs(c[3] - 1));
    counted++;
    if (diff > worst) worst = diff;
    if (diff > 8) { over8++; where.push([p % W, Math.floor(p / W), Math.round(diff)]); }
  }
  // The worst, not the first: the first sixteen are whichever edge the scan
  // reaches first, which says nothing about where the real trouble is.
  where.sort((a, b) => b[2] - a[2]);
  report.rest = { pixels: counted, worstChannelDiff: Math.round(worst * 10) / 10, pixelsOver8: over8, where: where.slice(0, 16) };
}

// 8. One crop for every layer, so they stay registered.
let minX = W, minY = H, maxX = -1, maxY = -1;
for (const arr of [body, layers.wingLeft, layers.wingRight, layers.eyes]) {
  for (let p = 0; p < N; p++) {
    if (arr[p * 4 + 3] <= 0.03) continue;
    const x = p % W, y = (p - x) / W;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
}
const TW = maxX - minX + 1, TH = maxY - minY + 1;

function toCanvas(arr) {
  const full = makeCanvas(W, H);
  const g = full.getContext('2d');
  const img = g.createImageData(W, H);
  for (let p = 0; p < N * 4; p += 4) {
    img.data[p] = clamp(Math.round(arr[p]), 0, 255);
    img.data[p + 1] = clamp(Math.round(arr[p + 1]), 0, 255);
    img.data[p + 2] = clamp(Math.round(arr[p + 2]), 0, 255);
    img.data[p + 3] = clamp(Math.round(arr[p + 3] * 255), 0, 255);
  }
  g.putImageData(img, 0, 0);
  const out = makeCanvas(TW, TH);
  out.getContext('2d').drawImage(full, minX, minY, TW, TH, 0, 0, TW, TH);
  return out;
}
const canvases = {
  body: toCanvas(body),
  wingLeft: toCanvas(layers.wingLeft),
  wingRight: toCanvas(layers.wingRight),
  eyes: toCanvas(layers.eyes),
};

const rig = {
  width: TW,
  height: TH,
  wingLeftPivot: [(cfg.wings.left.pivot[0] - minX) / TW, (cfg.wings.left.pivot[1] - minY) / TH],
  wingRightPivot: [(cfg.wings.right.pivot[0] - minX) / TW, (cfg.wings.right.pivot[1] - minY) / TH],
  eyeLine: ((eyes[0].cy + eyes[1].cy) / 2 - minY) / TH,
  eyeRadius: ((eyes[0].r + eyes[1].r) / 2) / TW,
};

// 9. Debug sheet: at rest, body alone, wings out + blink, wave + glance.
let debug = null;
if (cfg.debug) {
  const scale = 1.5, padX = 70, padY = 20;
  const panelW = TW * scale + padX * 2, panelH = TH * scale + padY * 2;
  const all = ['body', 'wingLeft', 'wingRight', 'eyes'];
  const poses = [
    { wl: 0, wr: 0, blink: 1, look: [0, 0], layers: all },
    { wl: 0, wr: 0, blink: 1, look: [0, 0], layers: ['body'] },
    { wl: 30, wr: -30, blink: 0.12, look: [0, 0], layers: all },
    { wl: 0, wr: -60, blink: 1, look: [3, -3], layers: all },
    { wl: 0, wr: -140, blink: 1, look: [3, -3], layers: all },
  ];
  const sheet = makeCanvas(panelW * poses.length, panelH * 2);
  const g = sheet.getContext('2d');
  const grounds = ['#0e191e', '#f4f2ed'];
  const pivotPx = (pv) => [pv[0] * TW, pv[1] * TH];
  const pad = 0;
  grounds.forEach((ground, row) => {
    poses.forEach((pose, col) => {
      g.save();
      g.fillStyle = ground;
      g.fillRect(col * panelW, row * panelH, panelW, panelH);
      g.translate(col * panelW + padX + pad, row * panelH + padY + pad);
      g.scale(scale, scale);
      for (const name of pose.layers) {
        g.save();
        if (name === 'wingLeft' || name === 'wingRight') {
          const pv = pivotPx(name === 'wingLeft' ? rig.wingLeftPivot : rig.wingRightPivot);
          g.translate(pv[0], pv[1]);
          g.rotate(((name === 'wingLeft' ? pose.wl : pose.wr) * Math.PI) / 180);
          g.translate(-pv[0], -pv[1]);
        }
        if (name === 'eyes') {
          const ey = rig.eyeLine * TH;
          g.translate(pose.look[0], ey + pose.look[1]);
          g.scale(1, pose.blink);
          g.translate(0, -ey);
        }
        g.drawImage(canvases[name], 0, 0);
        g.restore();
      }
      g.restore();
    });
  });
  debug = sheet.toDataURL('image/png');
}

const files = {};
for (const name of Object.keys(canvases)) files[name] = canvases[name].toDataURL('image/webp', cfg.quality);
return { files, rig, report, crop: { minX, minY, TW, TH }, bg, debug };
`;

const OUTPUT: Record<string, string> = {
  body: 'nomi-body.webp',
  wingLeft: 'nomi-wing-left.webp',
  wingRight: 'nomi-wing-right.webp',
  eyes: 'nomi-eyes.webp',
};

async function main() {
  const args = process.argv.slice(2);
  const debugAt = args.indexOf('--debug');
  const debugDir = debugAt === -1 ? null : args[debugAt + 1];
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--debug');
  const sheet = positional[0] ?? join('design-reference', 'nomi-different-interactions.png');

  if (!existsSync(sheet)) {
    throw new Error(
      `No character sheet at ${sheet}.\n` +
        'It is reference material and deliberately not in git — see .gitignore.',
    );
  }

  const dataUri = `data:image/png;base64,${readFileSync(sheet).toString('base64')}`;
  const page = await openCanvasPage('nomi');

  try {
    const result = await page.evaluate<{
      files: Record<string, string>;
      rig: Record<string, unknown>;
      report: Record<string, unknown>;
      crop: Record<string, number>;
      bg: number[];
      debug: string | null;
    }>(`(async (cfg) => {${PAGE}})(${JSON.stringify({ ...CONFIG, dataUri, debug: !!debugDir })})`);

    for (const [name, uri] of Object.entries(result.files)) {
      const file = join('assets', OUTPUT[name]!);
      const bytes = Buffer.from(uri.split(',')[1]!, 'base64');
      writeFileSync(file, bytes);
      console.log(`  ${file}  ${(bytes.length / 1024).toFixed(1)} KB`);
    }
    if (debugDir && result.debug) {
      mkdirSync(debugDir, { recursive: true });
      const file = join(debugDir, 'nomi-rig-debug.png');
      writeFileSync(file, Buffer.from(result.debug.split(',')[1]!, 'base64'));
      console.log(`  ${file}`);
    }
    console.log('\npaper colour', result.bg.map((v) => Math.round(v)).join(','));
    console.log('crop', JSON.stringify(result.crop));
    console.log('report', JSON.stringify(result.report, null, 2));
    const round = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(round) : typeof v === 'number' ? Math.round(v * 10000) / 10000 : v;
    const rig = Object.fromEntries(Object.entries(result.rig).map(([k, v]) => [k, round(v)]));
    const rigFile = join('src', 'ui', 'nomi-rig.ts');
    writeFileSync(
      rigFile,
      [
        '/**',
        " * Where Nomi's moving parts attach, as fractions of the layer size.",
        ' *',
        ' * GENERATED by scripts/make-nomi-assets.ts, in the same run that cuts',
        ' * assets/nomi-*.webp. Do not edit by hand: these numbers describe those exact',
        ' * images, and are only correct for them.',
        ' */',
        `export const NOMI_RIG = ${JSON.stringify(rig, null, 2)} as const;`,
        '',
      ].join('\n'),
    );
    console.log(`\n  ${rigFile}`);
    console.log('rig', JSON.stringify(rig));
  } finally {
    page.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
