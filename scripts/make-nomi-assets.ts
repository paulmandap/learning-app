/**
 * Cut Nomi's canonical pose into the layers the character is animated from.
 *
 *   npx tsx scripts/make-nomi-assets.ts
 *   npx tsx scripts/make-nomi-assets.ts <sheet.png> --debug <dir>
 *
 * Reads the character reference sheet from `design-reference/` (gitignored —
 * reference material, not an app asset) and writes five same-size, transparent
 * WebP layers to `assets/`:
 *
 *   nomi-body.webp        everything that does not move on its own
 *   nomi-wing-left.webp   rotates about the shoulder
 *   nomi-wing-right.webp
 *   nomi-eye-left.webp    each iris on its own: squashed to blink, shifted to look
 *   nomi-eye-right.webp
 *
 * And writes the rig — pivots and each eye's line, as fractions of the layer
 * size — to `src/ui/nomi-rig.ts`, in the same run. The numbers describe those
 * exact images, so they are only ever written together; a rig typed in by hand
 * would be one re-cut away from wings that pivot about thin air.
 *
 * ## The sheet (NOTES §41)
 *
 * `nomi-updated-look-interactions-references.png`, 1536×1024: the owner's new
 * look for Nomi. It replaced `nomi-different-interactions.png` (NOTES §35.5),
 * and three things about the new owl changed how it is cut:
 *
 *  - **The head tilts**, so the eyes are not level — the left iris sits 33px
 *    higher than the right. One eye layer blinking toward the line between them
 *    would slide both eyes while they close. Each eye is its own layer, with its
 *    own line.
 *  - **The head is wider than the body** and overhangs it, so the old way of
 *    finding the body behind a wing — one ellipse fitted to the silhouette above
 *    and below the wings — would fit the head, and leave a body-coloured ghost of
 *    the right wing behind when it waves. Where the body runs under each wing is
 *    placed by hand, like the wing outlines.
 *  - **The belly borders the wings.** The body colour behind a wing used to be
 *    read just inside the wing's inner edge; here that is cream belly, which a
 *    lifted wing would uncover as a cream patch. It is blended instead between
 *    two brown samples of the body itself, at the shoulder and below the wing.
 *
 * ## Why layers cut from ONE pose, not the poses on the sheet
 *
 * The sheet draws each state as a separate illustration, and they do not line
 * up: the owl is a different size and sits in a different place in every cell.
 * Cross-fading between them ghosts, for the same reason the pet's five stages
 * had to come from one generated image (NOTES §17.5). Parts of a single pose
 * move without ever changing what the owl is.
 *
 * ## What is behind a wing
 *
 * The art is flat. Where a wing overlaps the body there is no body underneath
 * it, so a wing that lifts would uncover a hole. Under each wing the body is
 * filled to its hand-placed edge with the blended body colour; beyond that edge
 * is paper, and stays transparent.
 *
 * The wing outlines are hand-placed polygons, read off a 4× gridded crop. TIGHT
 * against the belly — a polygon a pixel into the cream carries a cream sliver
 * up with the wing — and loose only where the neighbour is the same brown.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCanvasPage } from './chrome-canvas';

type Point = [number, number];

/**
 * Where everything is, in pixels of the SHEET, measured from
 * `design-reference/nomi-updated-look-interactions-references.png` (1536×1024)
 * on 4× gridded crops. Converted to frame coordinates before the page sees them.
 * Regenerating the sheet at another size or layout invalidates every number.
 */
const SHEET = {
  /** The canonical pose, inside its panel, clear of the label above and the name below. */
  frame: { x: 40, y: 235, w: 390, h: 530 },

  /**
   * Outlines are 3px LOOSE on the outer side, where the neighbour is paper and
   * taking a little of it costs nothing: drawn tight on the first cut, each
   * wing left its own outer outline standing beside the body as a thin dark
   * arc when it lifted. Tight on the inner side, against the belly.
   */
  wings: {
    left: {
      points: [
        [107, 516], [120, 518], [138, 523], [151, 531], [160, 546], [164, 566], [162, 585],
        [158, 602], [151, 619], [141, 634], [128, 647], [113, 659], [100, 670], [90, 679],
        [79, 679], [70, 672], [63, 657], [59, 639], [58, 619], [59, 597], [64, 578],
        [72, 559], [82, 540], [93, 523], [101, 517],
      ] as Point[],
      pivot: [116, 528] as Point,
      /** Where the body runs under the wing, as [y, x], top to bottom. */
      bodyEdge: [[516, 108], [550, 98], [590, 93], [630, 94], [665, 99], [690, 110]] as Point[],
      /**
       * Brown body above the wing, at the side of the head, and in the shadowed
       * lobe below it. The first cut took the upper sample beside the wing's
       * top, which is cream belly, and the body behind the lifted wing came out
       * pale.
       */
      fill: { top: [90, 500] as Point, bottom: [115, 690] as Point },
    },
    right: {
      points: [
        [307, 551], [322, 550], [340, 548], [354, 545], [366, 550], [374, 566], [379, 589],
        [381, 605], [378, 626], [373, 644], [365, 662], [351, 678], [335, 688], [319, 692],
        [312, 688], [316, 674], [324, 659], [329, 642], [331, 624], [330, 604], [326, 584],
        [318, 567], [309, 554],
      ] as Point[],
      pivot: [344, 556] as Point,
      bodyEdge: [[546, 354], [570, 352], [600, 351], [630, 348], [660, 340], [690, 322]] as Point[],
      fill: { top: [338, 575] as Point, bottom: [336, 660] as Point },
    },
  },

  /**
   * Starting guesses for the irises; the page measures the real centre and
   * radius from the pixels. Left, then right, as the viewer sees them.
   */
  eyes: [
    { cx: 168, cy: 408 },
    { cx: 320, cy: 441 },
  ],
};

const toFrame = (p: Point): Point => [p[0] - SHEET.frame.x, p[1] - SHEET.frame.y];
const edgeToFrame = (p: Point): Point => [p[0] - SHEET.frame.y, p[1] - SHEET.frame.x];

const CONFIG = {
  frame: SHEET.frame,

  /**
   * Paper, and the ground shadow drawn on it. Both are pale and nearly neutral;
   * the belly and the face are warmer than this allows, and are enclosed by the
   * body anyway, so a flood from the edge can never reach them.
   */
  paperMinLuma: 200,
  paperMaxWarmth: 40,

  /** Pixels this close to the paper get their alpha estimated, not copied. */
  edgeBand: 3,

  wings: Object.fromEntries(
    (['left', 'right'] as const).map((side) => {
      const w = SHEET.wings[side];
      return [
        side,
        {
          points: w.points.map(toFrame),
          pivot: toFrame(w.pivot),
          bodyEdge: w.bodyEdge.map(edgeToFrame),
          fill: { top: toFrame(w.fill.top), bottom: toFrame(w.fill.bottom) },
        },
      ];
    }),
  ),

  /** Iris edge: the first pixels paler than this, walking out from the pupil. */
  irisMaxLuma: 215,
  /** Added to each measured iris radius, for the reason given on `eyes`. */
  eyeMargin: 1.25,

  /**
   * Generous on purpose: a radius a little too large takes a sliver of the
   * cream face with the eye, which is invisible against the cream it squashes
   * over; too small leaves a brown ring on the face during every blink.
   */
  eyes: SHEET.eyes.map((e) => ({ cx: e.cx - SHEET.frame.x, cy: e.cy - SHEET.frame.y })),
  eyeFeather: 1.5,
  /** The face colour behind an eye is read on a ring this far outside it. */
  ringOffset: 6,
  /** Rays that measure an iris start this far out, past the white highlight, and give up here. */
  rayFrom: 22,
  rayTo: 70,

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
  if (paper[p] && lumaAt(p) > 225) { bgR += d[p * 4]; bgG += d[p * 4 + 1]; bgB += d[p * 4 + 2]; bgN++; }
}
if (!bgN) throw new Error('no paper found in the frame');
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

/** Where the body ends in a row: straight between the hand-placed [y, x] points, held beyond the ends. */
function edgeAt(points, y) {
  if (y <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (y <= b[0]) return a[1] + ((b[1] - a[1]) * (y - a[0])) / (b[0] - a[0]);
  }
  return points[points.length - 1][1];
}

/** A 5×5 patch of the owl's own colour, averaged. Throws if it is not on the owl. */
function patch(pt) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = pt[0] + dx, y = pt[1] + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const q = (y * W + x) * 4;
    if (owl[q + 3] < 1) continue;
    r += owl[q]; g += owl[q + 1]; b += owl[q + 2]; n++;
  }
  if (!n) throw new Error('fill sample at ' + pt.join(',') + ' (frame) is not on the owl');
  return [r / n, g / n, b / n];
}

/** Per row, the body colour behind a wing: blended from the shoulder sample to the one below. */
function rowFill(spec) {
  const top = patch(spec.fill.top), bottom = patch(spec.fill.bottom);
  const y0 = spec.fill.top[1], y1 = spec.fill.bottom[1];
  const out = new Array(H);
  for (let y = 0; y < H; y++) {
    const t = clamp((y - y0) / (y1 - y0), 0, 1);
    out[y] = [0, 1, 2].map((ch) => top[ch] + (bottom[ch] - top[ch]) * t);
  }
  return { rows: out, top, bottom };
}

const body = new Float32Array(owl);
const layers = {
  wingLeft: new Float32Array(N * 4),
  wingRight: new Float32Array(N * 4),
  eyeLeft: new Float32Array(N * 4),
  eyeRight: new Float32Array(N * 4),
};
const report = { fill: {} };

for (const side of ['left', 'right']) {
  const spec = cfg.wings[side];
  const mask = coverage(spec.points);
  const fillSpec = rowFill(spec);
  const fill = fillSpec.rows;
  report.fill[side] = { top: fillSpec.top.map(Math.round), bottom: fillSpec.bottom.map(Math.round) };
  const wing = side === 'left' ? layers.wingLeft : layers.wingRight;
  for (let p = 0; p < N; p++) {
    const m = mask[p];
    if (m <= 0) continue;
    const q = p * 4, x = p % W, y = (p - x) / W;
    wing[q] = owl[q]; wing[q + 1] = owl[q + 1]; wing[q + 2] = owl[q + 2]; wing[q + 3] = owl[q + 3] * m;
    const edge = edgeAt(spec.bodyEdge, y + 0.5);
    const inside = side === 'left' ? clamp(x + 0.5 - edge, 0, 1) : clamp(edge - x + 0.5, 0, 1);
    const f = fill[y];

    // A pixel on the polygon's own antialiased edge, where the owl is opaque:
    // split it EXACTLY rather than blending. Blending left the wing's dark
    // inner shadow mixed into the fill (NOTES §35.5). The body stays opaque
    // under a part-covered pixel; the edge only decides where the wing is
    // SOLID and the body behind it has to end.
    if (owl[q + 3] >= 0.999 && m < 1) {
      // Mostly body: leave the body as drawn; the wing adds its share of the
      // same colour, so m·O + (1 − m)·O = O.
      if (m < 0.5) continue;
      // Mostly wing: the body under it is the fill, and the wing takes the
      // colour that makes m·wing + (1 − m)·fill come back to the original.
      const solved = [0, 1, 2].map((ch) => (owl[q + ch] - (1 - m) * f[ch]) / m);
      // Unless no colour can. A dark outline pixel over a paler fill needs a
      // wing colour below 0; clamping it left a light line along the wing at
      // rest — worst 68 on the new sheet's first cut (NOTES §41). Such a pixel
      // stays as drawn on both layers instead: exact at rest, and one pixel of
      // it is left behind when the wing lifts.
      if (solved.some((c) => c < -2 || c > 257)) continue;
      for (let ch = 0; ch < 3; ch++) wing[q + ch] = clamp(solved[ch], 0, 255);
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
 * The real centre and radius of an iris, from where its darkness ends.
 *
 * Rays start past the white highlight, which sits inside the pupil and would
 * otherwise read as the iris ending early. Opposite rays re-centre the
 * estimate: if the left ray is longer than the right, the centre is left.
 */
function measureEye(guess) {
  let cx = guess.cx, cy = guess.cy, radius = 0;
  const RAYS = 72;
  for (let pass = 0; pass < 3; pass++) {
    const len = [];
    for (let k = 0; k < RAYS; k++) {
      const t = (k / RAYS) * Math.PI * 2;
      let r = cfg.rayFrom;
      for (; r < cfg.rayTo; r += 0.25) {
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
  if (radius >= cfg.rayTo - 1) throw new Error('an iris never ended within ' + cfg.rayTo + 'px of ' + guess.cx + ',' + guess.cy);
  return { cx, cy, r: radius + cfg.eyeMargin };
}
const eyes = cfg.eyes.map(measureEye);
report.eyes = eyes.map((e) => ({ cx: Math.round(e.cx * 10) / 10, cy: Math.round(e.cy * 10) / 10, r: Math.round(e.r * 10) / 10 }));

eyes.forEach((e, i) => {
  const layer = i === 0 ? layers.eyeLeft : layers.eyeRight;
  const ringR = e.r + cfg.ringOffset;
  // Only the FACE counts as what is behind an eye. Beside the right eye the
  // ring crosses the beak, and averaging its orange in painted an orange wedge
  // on the face that showed through every blink (NOTES §41). Samples paler than
  // the iris edge are face; where a stretch of ring has none, the eye's own
  // average face colour stands in.
  const faceLike = (s) => 0.3 * s[0] + 0.59 * s[1] + 0.11 * s[2] > cfg.irisMaxLuma;
  const faceSum = [0, 0, 0];
  let faceN = 0;
  for (let k = 0; k < 72; k++) {
    const t = (k / 72) * Math.PI * 2;
    const s = sampleOwl(e.cx + ringR * Math.cos(t), e.cy + ringR * Math.sin(t));
    if (!faceLike(s)) continue;
    faceSum[0] += s[0]; faceSum[1] += s[1]; faceSum[2] += s[2]; faceN++;
  }
  if (!faceN) throw new Error('no face colour around the eye at ' + Math.round(e.cx) + ',' + Math.round(e.cy));
  const faceColour = faceSum.map((c) => c / faceN);
  for (let y = Math.floor(e.cy - e.r - 4); y <= Math.ceil(e.cy + e.r + 4); y++) {
    for (let x = Math.floor(e.cx - e.r - 4); x <= Math.ceil(e.cx + e.r + 4); x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const dd = Math.hypot(x + 0.5 - e.cx, y + 0.5 - e.cy);
      const cov = clamp((e.r + cfg.eyeFeather - dd) / cfg.eyeFeather, 0, 1);
      if (cov <= 0) continue;
      const q = (y * W + x) * 4;
      layer[q] = owl[q]; layer[q + 1] = owl[q + 1]; layer[q + 2] = owl[q + 2];
      layer[q + 3] = owl[q + 3] * cov;
      // Mostly face: leave the face as drawn — the eye's share is the same colour.
      if (cov < 0.5) continue;
      const theta = Math.atan2(y + 0.5 - e.cy, x + 0.5 - e.cx);
      const ringSum = [0, 0, 0];
      let ringN = 0;
      for (let k = -2; k <= 2; k++) {
        const t = theta + k * 0.12;
        const s = sampleOwl(e.cx + ringR * Math.cos(t), e.cy + ringR * Math.sin(t));
        if (!faceLike(s)) continue;
        ringSum[0] += s[0]; ringSum[1] += s[1]; ringSum[2] += s[2]; ringN++;
      }
      const ring = ringN ? ringSum.map((c) => c / ringN) : faceColour;
      // Mostly eye: the face behind is the ring colour, and the eye takes the
      // colour that makes cov·eye + (1 − cov)·ring come back to the original.
      for (let ch = 0; ch < 3; ch++) {
        if (cov < 1) layer[q + ch] = clamp((owl[q + ch] - (1 - cov) * ring[ch]) / cov, 0, 255);
        body[q + ch] = ring[ch];
      }
    }
  }
});

// 7. At rest the layers must reproduce the owl. Measured, not assumed.
//
// Non-finite values first, and loudly. NaN fails every comparison, so a layer
// full of it sails through a "worst difference" check as a pass (NOTES §35.5).
const allLayers = [['body', body], ['wingLeft', layers.wingLeft], ['wingRight', layers.wingRight], ['eyeLeft', layers.eyeLeft], ['eyeRight', layers.eyeRight]];
for (const [name, arr] of allLayers) {
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
    c = over(px(layers.eyeLeft, q), c);
    c = over(px(layers.eyeRight, q), c);
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
for (const [, arr] of allLayers) {
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
  eyeLeft: toCanvas(layers.eyeLeft),
  eyeRight: toCanvas(layers.eyeRight),
};

const rig = {
  width: TW,
  height: TH,
  wingLeftPivot: [(cfg.wings.left.pivot[0] - minX) / TW, (cfg.wings.left.pivot[1] - minY) / TH],
  wingRightPivot: [(cfg.wings.right.pivot[0] - minX) / TW, (cfg.wings.right.pivot[1] - minY) / TH],
  eyeLeftLine: (eyes[0].cy - minY) / TH,
  eyeRightLine: (eyes[1].cy - minY) / TH,
  eyeRadius: ((eyes[0].r + eyes[1].r) / 2) / TW,
};

// 9. Debug sheet: at rest, body alone, wings out + blink, wave, full wave + glance.
let debug = null;
if (cfg.debug) {
  const scale = 1.5, padX = 90, padY = 30;
  const panelW = TW * scale + padX * 2, panelH = TH * scale + padY * 2;
  const all = ['body', 'eyeLeft', 'eyeRight', 'wingLeft', 'wingRight'];
  const poses = [
    { wl: 0, wr: 0, blink: 1, look: [0, 0], layers: all },
    { wl: 0, wr: 0, blink: 1, look: [0, 0], layers: ['body'] },
    { wl: 35, wr: 35, blink: 0.1, look: [0, 0], layers: all },
    { wl: 0, wr: 60, blink: 1, look: [4, -4], layers: all },
    { wl: 0, wr: 135, blink: 1, look: [4, -4], layers: all },
  ];
  const sheet = makeCanvas(panelW * poses.length, panelH * 2);
  const g = sheet.getContext('2d');
  const grounds = ['#0e191e', '#f4f2ed'];
  const pivotPx = (pv) => [pv[0] * TW, pv[1] * TH];
  grounds.forEach((ground, row) => {
    poses.forEach((pose, col) => {
      g.save();
      g.fillStyle = ground;
      g.fillRect(col * panelW, row * panelH, panelW, panelH);
      g.translate(col * panelW + padX, row * panelH + padY);
      g.scale(scale, scale);
      for (const name of pose.layers) {
        g.save();
        if (name === 'wingLeft' || name === 'wingRight') {
          const pv = pivotPx(name === 'wingLeft' ? rig.wingLeftPivot : rig.wingRightPivot);
          g.translate(pv[0], pv[1]);
          // Positive is OUTWARD for both wings, as in the app.
          g.rotate(((name === 'wingLeft' ? pose.wl : -pose.wr) * Math.PI) / 180);
          g.translate(-pv[0], -pv[1]);
        }
        if (name === 'eyeLeft' || name === 'eyeRight') {
          const ey = (name === 'eyeLeft' ? rig.eyeLeftLine : rig.eyeRightLine) * TH;
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
  eyeLeft: 'nomi-eye-left.webp',
  eyeRight: 'nomi-eye-right.webp',
};

async function main() {
  const args = process.argv.slice(2);
  const debugAt = args.indexOf('--debug');
  const debugDir = debugAt === -1 ? null : args[debugAt + 1];
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--debug');
  const sheet = positional[0] ?? join('design-reference', 'nomi-updated-look-interactions-references.png');

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
