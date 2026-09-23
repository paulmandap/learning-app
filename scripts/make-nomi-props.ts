/**
 * Cut Nomi's props out of the sheet the owner made with Gemini (NOTES §50).
 *
 *   npx tsx scripts/make-nomi-props.ts [<sheet>] [--debug <dir>]
 *
 * Reads `design-reference/nomi-props.jfif` (gitignored — reference material, not
 * an app asset): a 3 × 3 grid, one prop to a cell on a flat pale background,
 * drawn from the prompt in NOTES §49's plan. Writes each prop as a see-through
 * WebP, `assets/nomi-prop-<name>.webp`, and their sizes to
 * `src/ui/nomi-prop-art.ts` in the same run — the numbers describe those exact
 * images, so they are only ever written together.
 *
 * ## Why props, and not a new Nomi
 *
 * Nomi's moving parts are cut from exact pixels of one drawing (§41), and a new
 * drawing of the owl would not line up with them. A prop is its own picture,
 * placed over the owl we have (`PROP_PLACES` in `src/core/nomi-props.ts`).
 *
 * ## How a cell is cut
 *
 * The same way `make-nomi-assets.ts` finds the owl: the paper is flooded in from
 * the cell's edges through pale, neutral pixels, and what the flood cannot reach
 * is the prop — so a pale lens or cream pages inside an outline stay, because
 * the outline keeps the flood out. Unlike the owl, a prop may be several pieces
 * (the sparkles are three, the mug has its steam), so every piece is kept but
 * specks: a JPEG leaves a few stray pixels, and a piece smaller than
 * `minPiece` is one of those. Edge pixels get their alpha estimated against the
 * paper, so no pale fringe shows on dark mode.
 *
 * A prop touching its cell's edge fails the run: it is either cut in half or
 * carrying a piece of its neighbour.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { openCanvasPage } from './chrome-canvas';

/** The props, in the sheet's order: left to right, top to bottom. */
const NAMES = ['book', 'lightbulb', 'magnifier', 'pencil', 'cap', 'nightcap', 'heart', 'mug', 'sparkles'] as const;

const CONFIG = {
  columns: 3,
  rows: 3,
  /** Paper: pale and nearly neutral. As in make-nomi-assets.ts. */
  paperMinLuma: 200,
  paperMaxWarmth: 40,
  /** Pieces smaller than this many pixels are JPEG specks, not props. */
  minPiece: 60,
  /** Pixels this close to the paper get their alpha estimated, not copied. */
  edgeBand: 3,
  /** Transparent margin kept around each trimmed prop. */
  pad: 2,
  quality: 0.92,
};

/** The page-side work, plain JavaScript run in Chrome. No template literals inside it. */
const PAGE = String.raw`
const img = new Image();
img.src = cfg.dataUri;
await img.decode();
const SW = img.naturalWidth, SH = img.naturalHeight;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const sheet = makeCanvas(SW, SH);
const sg = sheet.getContext('2d', { willReadFrequently: true });
sg.drawImage(img, 0, 0);

const out = {};
const report = [];
for (let r = 0; r < cfg.rows; r++) for (let c = 0; c < cfg.columns; c++) {
  const name = cfg.names[r * cfg.columns + c];
  const x0 = Math.round((c * SW) / cfg.columns), x1 = Math.round(((c + 1) * SW) / cfg.columns);
  const y0 = Math.round((r * SH) / cfg.rows), y1 = Math.round(((r + 1) * SH) / cfg.rows);
  const W = x1 - x0, H = y1 - y0, N = W * H;
  const d = sg.getImageData(x0, y0, W, H).data;
  const lumaAt = (p) => 0.3 * d[p * 4] + 0.59 * d[p * 4 + 1] + 0.11 * d[p * 4 + 2];
  const isPaper = (p) => lumaAt(p) >= cfg.paperMinLuma && d[p * 4] - d[p * 4 + 2] <= cfg.paperMaxWarmth;

  // 1. Paper, flooded in from the cell's edges.
  const paper = new Uint8Array(N);
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
  let bgR = 0, bgG = 0, bgB = 0, bgN = 0;
  for (let p = 0; p < N; p++) if (paper[p]) { bgR += d[p * 4]; bgG += d[p * 4 + 1]; bgB += d[p * 4 + 2]; bgN++; }
  if (!bgN) throw new Error(name + ': no paper in its cell');
  const bg = [bgR / bgN, bgG / bgN, bgB / bgN];

  // 2. Every piece big enough to be part of the prop.
  const comp = new Int32Array(N).fill(-1);
  const sizes = [];
  for (let s = 0; s < N; s++) {
    if (paper[s] || comp[s] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    const st = [s];
    comp[s] = id;
    while (st.length) {
      const p = st.pop();
      size++;
      const x = p % W, y = (p - x) / W;
      const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const q of nb) if (q >= 0 && !paper[q] && comp[q] === -1) { comp[q] = id; st.push(q); }
    }
    sizes.push(size);
  }
  const keep = sizes.map((s) => s >= cfg.minPiece);
  const inProp = (p) => comp[p] >= 0 && keep[comp[p]];
  const pieces = keep.filter(Boolean).length;
  if (!pieces) throw new Error(name + ': nothing found in its cell');

  // 3. Touching the cell's edge means cut in half, or carrying a neighbour.
  for (let x = 0; x < W; x++) if (inProp(x) || inProp((H - 1) * W + x)) throw new Error(name + ' touches the top or bottom of its cell');
  for (let y = 0; y < H; y++) if (inProp(y * W) || inProp(y * W + W - 1)) throw new Error(name + ' touches the side of its cell');

  // 4. Distance from outside the prop (3-4 chamfer), for the edge band.
  const dist = new Float32Array(N);
  for (let p = 0; p < N; p++) dist[p] = inProp(p) ? 1e9 : 0;
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

  // 5. Colour and alpha: edge pixels take the colour just inside them, and an
  //    alpha from how far they sit between the paper and that colour.
  const rgba = new Float32Array(N * 4);
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let p = 0; p < N; p++) {
    if (!inProp(p)) continue;
    const q = p * 4, x = p % W, y = (p - x) / W;
    let alpha = 1, col = [d[q], d[q + 1], d[q + 2]];
    if (dist[p] < cfg.edgeBand) {
      let rr = 0, gg = 0, bb = 0, n = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const pp = yy * W + xx;
        if (!inProp(pp) || dist[pp] < cfg.edgeBand) continue;
        rr += d[pp * 4]; gg += d[pp * 4 + 1]; bb += d[pp * 4 + 2]; n++;
      }
      if (n) {
        const inner = [rr / n, gg / n, bb / n];
        const u = [inner[0] - bg[0], inner[1] - bg[1], inner[2] - bg[2]];
        const v = [d[q] - bg[0], d[q + 1] - bg[1], d[q + 2] - bg[2]];
        const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
        alpha = uu > 0 ? clamp((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / uu, 0, 1) : 1;
        col = inner;
      }
    }
    if (alpha < 0.08) continue;
    rgba[q] = col[0]; rgba[q + 1] = col[1]; rgba[q + 2] = col[2]; rgba[q + 3] = alpha;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }

  // 6. Trimmed, with a little room, and encoded.
  minX = Math.max(0, minX - cfg.pad); minY = Math.max(0, minY - cfg.pad);
  maxX = Math.min(W - 1, maxX + cfg.pad); maxY = Math.min(H - 1, maxY + cfg.pad);
  const TW = maxX - minX + 1, TH = maxY - minY + 1;
  const canvas = makeCanvas(TW, TH);
  const g = canvas.getContext('2d');
  const imgData = g.createImageData(TW, TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    const s = ((y + minY) * W + (x + minX)) * 4, t = (y * TW + x) * 4;
    imgData.data[t] = clamp(Math.round(rgba[s]), 0, 255);
    imgData.data[t + 1] = clamp(Math.round(rgba[s + 1]), 0, 255);
    imgData.data[t + 2] = clamp(Math.round(rgba[s + 2]), 0, 255);
    imgData.data[t + 3] = clamp(Math.round(rgba[s + 3] * 255), 0, 255);
  }
  g.putImageData(imgData, 0, 0);
  out[name] = { uri: canvas.toDataURL('image/webp', cfg.quality), width: TW, height: TH, canvas };
  report.push({ name, pieces, specks: sizes.length - pieces, width: TW, height: TH, paper: bg.map(Math.round) });
}

// 7. Debug sheet: every prop on dark and on light, at its own size.
let debug = null;
if (cfg.debug) {
  const cellW = 380, cellH = 380;
  const debugSheet = makeCanvas(cellW * cfg.names.length, cellH * 2);
  const g = debugSheet.getContext('2d');
  ['#0e191e', '#f4f2ed'].forEach((ground, row) => {
    cfg.names.forEach((name, i) => {
      g.fillStyle = ground;
      g.fillRect(i * cellW, row * cellH, cellW, cellH);
      const p = out[name];
      g.drawImage(p.canvas, i * cellW + (cellW - p.width) / 2, row * cellH + (cellH - p.height) / 2);
    });
  });
  debug = debugSheet.toDataURL('image/png');
}

const files = {};
for (const name of cfg.names) files[name] = { uri: out[name].uri, width: out[name].width, height: out[name].height };
return { files, report, debug, size: [SW, SH] };
`;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  // JFIF is JPEG: the name of its file format, and what Gemini saves.
  '.jfif': 'image/jpeg',
  '.webp': 'image/webp',
};

async function main() {
  const args = process.argv.slice(2);
  const debugAt = args.indexOf('--debug');
  const debugDir = debugAt === -1 ? null : args[debugAt + 1];
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--debug');
  const sheet = positional[0] ?? join('design-reference', 'nomi-props.jfif');
  if (!existsSync(sheet)) {
    throw new Error(`No props sheet at ${sheet}.\nIt is reference material and deliberately not in git — see .gitignore.`);
  }
  const mime = MIME[extname(sheet).toLowerCase()];
  if (!mime) throw new Error(`Cannot read ${extname(sheet)} — use a PNG, JPEG, JFIF or WebP.`);

  const dataUri = `data:${mime};base64,${readFileSync(sheet).toString('base64')}`;
  const page = await openCanvasPage('nomi-props');
  try {
    const result = await page.evaluate<{
      files: Record<string, { uri: string; width: number; height: number }>;
      report: unknown[];
      debug: string | null;
      size: [number, number];
    }>(`(async (cfg) => {${PAGE}})(${JSON.stringify({ ...CONFIG, names: NAMES, dataUri, debug: !!debugDir })})`);

    console.log(`sheet ${result.size.join('×')}`);
    for (const line of result.report) console.log(' ', JSON.stringify(line));
    for (const name of NAMES) {
      const file = join('assets', `nomi-prop-${name}.webp`);
      const bytes = Buffer.from(result.files[name]!.uri.split(',')[1]!, 'base64');
      writeFileSync(file, bytes);
      console.log(`  ${file}  ${(bytes.length / 1024).toFixed(1)} KB`);
    }
    if (debugDir && result.debug) {
      mkdirSync(debugDir, { recursive: true });
      const file = join(debugDir, 'nomi-props-debug.png');
      writeFileSync(file, Buffer.from(result.debug.split(',')[1]!, 'base64'));
      console.log(`  ${file}`);
    }

    const artFile = join('src', 'ui', 'nomi-prop-art.ts');
    writeFileSync(
      artFile,
      [
        '/**',
        " * Nomi's props as pictures, and each picture's size in pixels.",
        ' *',
        ' * GENERATED by scripts/make-nomi-props.ts, in the same run that cuts',
        ' * assets/nomi-prop-*.webp. Do not edit by hand: the sizes describe those',
        ' * exact images. Where each prop sits is `PROP_PLACES` in src/core/nomi-props.ts.',
        ' */',
        "import type { ImageSourcePropType } from 'react-native';",
        "import type { NomiProp } from '../core/nomi-props';",
        ...NAMES.map((name) => `import ${name} from '../../assets/nomi-prop-${name}.webp';`),
        '',
        'export const NOMI_PROP_ART: Record<NomiProp, { source: ImageSourcePropType; width: number; height: number }> = {',
        ...NAMES.map(
          (name) => `  ${name}: { source: ${name}, width: ${result.files[name]!.width}, height: ${result.files[name]!.height} },`,
        ),
        '};',
        '',
      ].join('\n'),
    );
    console.log(`\n  ${artFile}`);
  } finally {
    page.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
