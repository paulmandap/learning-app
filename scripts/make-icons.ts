/**
 * The app icon at every size the web build and the PWA need, from the owner's
 * artwork (NOTES §41).
 *
 *   npx tsx scripts/make-icons.ts
 *   npx tsx scripts/make-icons.ts <icon.png> --preview <dir>
 *
 * Replaces `make-icons.mjs`, which painted the old flashcard mark from shapes
 * transcribed by hand out of `assets/icon.svg`. The icon is now a picture the
 * owner chose — Nomi in a brown rounded square, on a pale page — so nothing is
 * drawn. The square is found in the picture, cut out, and scaled. The picture
 * lives in `design-reference/` (gitignored), like the character sheet.
 *
 * ## Measured from the pixels, not typed in
 *
 *  - **The square's edges**: where the page colour ends along the middle row
 *    and the middle column.
 *  - **Its corner radius**: how far the page reaches along each corner's
 *    diagonal, which for a rounded square is r·(1 − 1/√2). The median of the
 *    four corners, so one corner where the owl meets the edge cannot skew it.
 *
 * A picture regenerated at another size or with another margin needs no change
 * here — which is the point of measuring.
 *
 * ## Not quite square
 *
 * The owner's picture is 779 wide by 799 tall (measured 2026-09-14). Squashing
 * it square would make the owl 2.5% shorter, so the difference is trimmed off
 * the TOP, which is plain background above the ear tufts. The owl, and where
 * the bottom edge crops it, stay exactly as drawn.
 *
 * ## Two shapes of output
 *
 *  - **rounded** — the square's own corners, antialiased, transparent outside:
 *    the favicon, the PWA's "any" icons, `assets/icon.png`.
 *  - **full-bleed** — the square to the edge, its corners filled with the
 *    colour just inside the arc beside them: `apple-touch-icon`, because iOS
 *    masks home-screen icons itself and baked-in transparent corners render as
 *    a dark halo; and the maskable icon, which Android crops to its own shape
 *    well inside the corners.
 *
 * Either way the square's outermost pixels are trimmed first: the picture
 * antialiases its edge against the pale page, and that rim would otherwise come
 * along as a light fringe on a dark home screen.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openCanvasPage } from './chrome-canvas';

const CONFIG = {
  /** A pixel within this RGB distance of the page colour is page. */
  paperDistance: 28,
  /** Pixels trimmed from every edge of the square: its antialiased rim. */
  edgeInset: 2,
  /** A full-bleed corner takes its colour from this far inside the arc. */
  cornerSampleInset: 3,
  /** How far from square, as a share of the shorter side, the picture may be and still be trimmed. */
  maxSquareness: 0.05,
};

interface Target {
  file: string;
  size: number;
  shape: 'rounded' | 'full-bleed';
}

const TARGETS: Target[] = [
  { file: 'assets/icon.png', size: 1024, shape: 'rounded' },
  { file: 'assets/favicon.png', size: 48, shape: 'rounded' },
  { file: 'public/favicon.png', size: 48, shape: 'rounded' },
  { file: 'public/icon-192.png', size: 192, shape: 'rounded' },
  { file: 'public/icon-512.png', size: 512, shape: 'rounded' },
  { file: 'public/icon-512-maskable.png', size: 512, shape: 'full-bleed' },
  { file: 'public/apple-touch-icon.png', size: 180, shape: 'full-bleed' },
];

/**
 * The page-side work, in Chrome. Plain JavaScript in a string, like
 * `make-nomi-assets.ts`; no template literals inside it.
 */
const PAGE = String.raw`
const img = new Image();
img.src = cfg.dataUri;
await img.decode();
const IW = img.naturalWidth, IH = img.naturalHeight;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

const src = makeCanvas(IW, IH);
const sg = src.getContext('2d', { willReadFrequently: true });
sg.drawImage(img, 0, 0);
const d = sg.getImageData(0, 0, IW, IH).data;
const at = (x, y) => { const q = (y * IW + x) * 4; return [d[q], d[q + 1], d[q + 2]]; };

// 1. The page colour, from the top-left corner of the picture.
let pr = 0, pgr = 0, pb = 0, pn = 0;
for (let y = 4; y < 24; y++) for (let x = 4; x < 24; x++) { const c = at(x, y); pr += c[0]; pgr += c[1]; pb += c[2]; pn++; }
const paper = [pr / pn, pgr / pn, pb / pn];
const isPaper = (x, y) => {
  const c = at(x, y);
  return Math.hypot(c[0] - paper[0], c[1] - paper[1], c[2] - paper[2]) <= cfg.paperDistance;
};

// 2. The square's edges, along the middle row and column.
const midY = Math.floor(IH / 2), midX = Math.floor(IW / 2);
let x0 = 0; while (x0 < IW - 1 && isPaper(x0, midY)) x0++;
let x1 = IW - 1; while (x1 > 0 && isPaper(x1, midY)) x1--;
let y0 = 0; while (y0 < IH - 1 && isPaper(midX, y0)) y0++;
let y1 = IH - 1; while (y1 > 0 && isPaper(midX, y1)) y1--;
const w = x1 - x0 + 1, h = y1 - y0 + 1;
if (w < 64 || h < 64) throw new Error('no square found: x ' + x0 + '..' + x1 + ', y ' + y0 + '..' + y1);
if (Math.abs(w - h) > Math.min(w, h) * cfg.maxSquareness) {
  throw new Error('the icon is too far from square to trim: ' + w + 'x' + h);
}
// Taller than wide: the difference comes off the top. Wider: off the left.
const trimTop = Math.max(0, h - w), trimLeft = Math.max(0, w - h);

// 3. The corner radius, from how far the page reaches along each diagonal.
const corners = [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]];
const radii = corners.map((c) => {
  let k = 0;
  while (k < w / 2 && isPaper(c[0] + c[2] * k, c[1] + c[3] * k)) k++;
  return k / (1 - Math.SQRT1_2);
});
const sortedRadii = radii.slice().sort((a, b) => a - b);
const radius = (sortedRadii[1] + sortedRadii[2]) / 2;
if (!(radius > 0 && radius < w / 2)) throw new Error('no corner radius: ' + radii.join(', '));

// 4. The square without its antialiased rim, as a canvas of its own.
const S = Math.min(w, h) - 2 * cfg.edgeInset;
const R = radius - cfg.edgeInset;
const square = makeCanvas(S, S);
square.getContext('2d').drawImage(src, x0 + trimLeft + cfg.edgeInset, y0 + trimTop + cfg.edgeInset, S, S, 0, 0, S, S);

// 5. Full bleed: each corner outside the arc takes the colour just inside it,
//    along the line from the arc's centre, so a gradient carries on unbroken.
//    After a trim the new arc lies wholly inside the drawn square, so nothing
//    kept comes from the page.
const bleed = makeCanvas(S, S);
const bg = bleed.getContext('2d', { willReadFrequently: true });
bg.drawImage(square, 0, 0);
const bleedData = bg.getImageData(0, 0, S, S);
const bd = bleedData.data;
const orig = new Uint8ClampedArray(bd);
const centres = [[R, R], [S - R, R], [R, S - R], [S - R, S - R]];
let filled = 0;
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const px = x + 0.5, py = y + 0.5;
  let c = null;
  if (px < R && py < R) c = centres[0];
  else if (px > S - R && py < R) c = centres[1];
  else if (px < R && py > S - R) c = centres[2];
  else if (px > S - R && py > S - R) c = centres[3];
  if (!c) continue;
  const dx = px - c[0], dy = py - c[1], dist = Math.hypot(dx, dy);
  // Inside the arc and clear of its antialiasing: the picture as drawn.
  if (dist <= R - 1) continue;
  const t = (R - cfg.cornerSampleInset) / dist;
  const sx = clamp(Math.floor(c[0] + dx * t), 0, S - 1), sy = clamp(Math.floor(c[1] + dy * t), 0, S - 1);
  const q = (y * S + x) * 4, s = (sy * S + sx) * 4;
  bd[q] = orig[s]; bd[q + 1] = orig[s + 1]; bd[q + 2] = orig[s + 2]; bd[q + 3] = 255;
  filled++;
}
bg.putImageData(bleedData, 0, 0);

// 6. Scaled in halves, so a 48px favicon is not one coarse jump from ~770px.
function scaled(size) {
  let cur = bleed;
  while (cur.width / 2 >= size) {
    const half = makeCanvas(Math.round(cur.width / 2), Math.round(cur.height / 2));
    const g = half.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = makeCanvas(size, size);
  const g = out.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, size, size);
  return out;
}

// 7. Rounded: the square's own corners, from a rounded-rectangle distance,
//    so the edge is antialiased at the output size rather than scaled into it.
function rounded(canvas) {
  const size = canvas.width, r = (R / S) * size;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const data = g.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x + 0.5, py = y + 0.5;
    const cx = clamp(px, r, size - r), cy = clamp(py, r, size - r);
    const cover = clamp(r - Math.hypot(px - cx, py - cy) + 0.5, 0, 1);
    if (cover < 1) { const a = (y * size + x) * 4 + 3; data.data[a] = Math.round(data.data[a] * cover); }
  }
  g.putImageData(data, 0, 0);
  return canvas;
}

const outputs = {};
const drawn = {};
for (const t of cfg.targets) {
  const c = scaled(t.size);
  const final = t.shape === 'rounded' ? rounded(c) : c;
  drawn[t.file] = final;
  outputs[t.file] = final.toDataURL('image/png');
}

// 8. A preview: the sizes people see, on the app's dark ground and a light one.
let preview = null;
if (cfg.preview) {
  const show = ['public/icon-512.png', 'public/apple-touch-icon.png', 'public/icon-192.png', 'public/favicon.png'];
  const pad = 24;
  const width = show.reduce((sum, f) => sum + drawn[f].width + pad, pad);
  const rowH = 512 + pad * 2;
  const sheet = makeCanvas(width, rowH * 2);
  const g = sheet.getContext('2d');
  ['#0f1519', '#f7f7f8'].forEach((ground, row) => {
    g.fillStyle = ground;
    g.fillRect(0, row * rowH, width, rowH);
    let x = pad;
    for (const f of show) { g.drawImage(drawn[f], x, row * rowH + pad); x += drawn[f].width + pad; }
  });
  preview = sheet.toDataURL('image/png');
}

return {
  outputs,
  preview,
  report: {
    picture: [IW, IH],
    paper: paper.map((v) => Math.round(v)),
    square: { x0, y0, x1, y1, w, h, trimTop, trimLeft },
    cornerRadii: radii.map((v) => Math.round(v * 10) / 10),
    radius: Math.round(radius * 10) / 10,
    trimmedSide: S,
    cornerPixelsFilled: filled,
  },
};
`;

async function main() {
  const args = process.argv.slice(2);
  const previewAt = args.indexOf('--preview');
  const previewDir = previewAt === -1 ? null : args[previewAt + 1];
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--preview');
  const picture = positional[0] ?? join('design-reference', 'nomi-app-icon.png');

  if (!existsSync(picture)) {
    throw new Error(
      `No icon picture at ${picture}.\n` +
        'It is reference material and deliberately not in git — see .gitignore.',
    );
  }

  const dataUri = `data:image/png;base64,${readFileSync(picture).toString('base64')}`;
  const page = await openCanvasPage('icons');
  try {
    const result = await page.evaluate<{
      outputs: Record<string, string>;
      preview: string | null;
      report: Record<string, unknown>;
    }>(`(async (cfg) => {${PAGE}})(${JSON.stringify({ ...CONFIG, targets: TARGETS, dataUri, preview: !!previewDir })})`);

    for (const target of TARGETS) {
      const bytes = Buffer.from(result.outputs[target.file]!.split(',')[1]!, 'base64');
      mkdirSync(dirname(target.file), { recursive: true });
      writeFileSync(target.file, bytes);
      console.log(`  ${target.file}  ${target.size}x${target.size} ${target.shape}  ${(bytes.length / 1024).toFixed(1)} KB`);
    }
    if (previewDir && result.preview) {
      mkdirSync(previewDir, { recursive: true });
      const file = join(previewDir, 'icons-preview.png');
      writeFileSync(file, Buffer.from(result.preview.split(',')[1]!, 'base64'));
      console.log(`  ${file}`);
    }
    console.log('report', JSON.stringify(result.report, null, 2));
  } finally {
    page.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
