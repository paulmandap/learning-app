/**
 * Renders the app icon to PNG at every size the web build and the PWA need.
 *
 * No image dependencies. PNGs are written by hand with zlib, and the artwork is
 * rasterised by the small painter below.
 *
 * This is NOT an SVG parser. `assets/icon.svg` is the design's source of truth
 * and the SHAPES table is a hand transcription of it — if the SVG changes, the
 * table has to change with it. A general parser would be a lot of code to render
 * one file that changes once a year.
 *
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

// ---------------------------------------------------------------- PNG bits --

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode an RGBA pixel buffer as a PNG. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = compression, filter, interlace = 0

  // Each scanline is prefixed with a filter byte (0 = none).
  const stride = size * 4;
  const raw = Buffer.alloc(size * (1 + stride));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + stride)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (1 + stride) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- the artwork --

/** Design canvas, matching the SVG's viewBox. */
const VB = 1024;

const BACKGROUND = { fill: [0x0d, 0x0f, 0x17], radius: 224 };

/**
 * Everything drawn on top of the background, in paint order.
 *
 * Transcribed from assets/icon.svg. Coordinates are in viewBox units.
 */
const SHAPES = [
  // Back flashcard, angled behind the front one and peeking out to the LOWER
  // LEFT.
  //
  // This deviates from assets/icon.svg, deliberately. That file says
  // `rotate(10 520 500)` on a card centred up and to the RIGHT of the front
  // card, which renders the stack peeking out top-right. The reference image
  // supplied with the design shows it lower-left, so the markup and the picture
  // disagree — and the picture is what was approved. assets/icon.svg carries a
  // note saying the same thing.
  {
    kind: 'rrect',
    x: 224, y: 258, w: 460, h: 580, r: 44,
    fill: [0x4a, 0x6c, 0xf7], alpha: 0.38,
    rotate: { deg: -10, cx: 454, cy: 548 },
  },
  // Front flashcard.
  { kind: 'rrect', x: 272, y: 232, w: 480, h: 580, r: 48, fill: [0x5e, 0x81, 0xf4], alpha: 1 },
  // Content lines.
  { kind: 'rrect', x: 340, y: 340, w: 220, h: 34, r: 17, fill: [0xff, 0xff, 0xff], alpha: 0.95 },
  { kind: 'rrect', x: 340, y: 410, w: 344, h: 20, r: 10, fill: [0xe0, 0xe7, 0xff], alpha: 0.75 },
  { kind: 'rrect', x: 340, y: 450, w: 280, h: 20, r: 10, fill: [0xe0, 0xe7, 0xff], alpha: 0.75 },
  // Accent spark.
  {
    kind: 'poly',
    points: [
      [630, 630], [645, 580], [660, 630], [710, 645],
      [660, 660], [645, 710], [630, 660], [580, 645],
    ],
    fill: [0xff, 0xff, 0xff], alpha: 1,
  },
];

// ------------------------------------------------------------- hit testing --

/** Inside a rounded rectangle? Corner test is the classic squared-distance one. */
function inRoundedRect(px, py, x, y, w, h, r) {
  const dx = Math.max(x + r - px, 0, px - (x + w - r));
  const dy = Math.max(y + r - py, 0, py - (y + h - r));
  return dx * dx + dy * dy <= r * r;
}

/** Even-odd crossing test. The spark is a simple non-self-intersecting octagon. */
function inPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function hits(shape, px, py) {
  if (shape.kind === 'poly') return inPolygon(px, py, shape.points);

  let x = px;
  let y = py;
  if (shape.rotate) {
    // Inverse-rotate the sample point into the shape's own space, which is far
    // cheaper than rotating the shape and re-deriving its edges.
    const a = (-shape.rotate.deg * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const ox = px - shape.rotate.cx;
    const oy = py - shape.rotate.cy;
    x = ox * cos - oy * sin + shape.rotate.cx;
    y = ox * sin + oy * cos + shape.rotate.cy;
  }
  return inRoundedRect(x, y, shape.x, shape.y, shape.w, shape.h, shape.r);
}

// ----------------------------------------------------------------- painter --

/**
 * Draw the icon at `size`, supersampled and then box-filtered down.
 *
 * Supersampling rather than analytic coverage: the shapes are few and the sizes
 * small, so brute force is simpler to trust than per-edge coverage maths, and
 * the result at 3x is clean at 180px.
 *
 * @param size    Output edge length in pixels.
 * @param rounded Round the background's corners. FALSE for apple-touch-icon:
 *                iOS applies its own superellipse mask, so baking corners in
 *                leaves transparent wedges that render as a dark halo.
 * @param inset   Scale factor for the artwork over the background. Below 1 for
 *                the maskable variant, which Android crops to a circle.
 */
function drawIcon(size, { rounded = true, inset = 1 } = {}) {
  const ss = size > 512 ? 2 : 3; // 1024 is already dense; 2x keeps it quick
  const S = size * ss;
  const buf = new Uint8ClampedArray(S * S * 4);

  const toUser = (p) => ((p + 0.5) / S) * VB;

  // --- background ---------------------------------------------------------
  for (let py = 0; py < S; py++) {
    const uy = toUser(py);
    for (let px = 0; px < S; px++) {
      const ux = toUser(px);
      if (rounded && !inRoundedRect(ux, uy, 0, 0, VB, VB, BACKGROUND.radius)) continue;
      const i = (py * S + px) * 4;
      buf[i] = BACKGROUND.fill[0];
      buf[i + 1] = BACKGROUND.fill[1];
      buf[i + 2] = BACKGROUND.fill[2];
      buf[i + 3] = 255;
    }
  }

  // --- shapes, source-over ------------------------------------------------
  const c = VB / 2;
  for (const shape of SHAPES) {
    // Only visit pixels the shape can reach. Without this a 1024 icon walks
    // every pixel six times over.
    const box = boundsOf(shape);
    const x0 = Math.max(0, Math.floor((((box.x0 - c) * inset + c) / VB) * S) - 2);
    const x1 = Math.min(S - 1, Math.ceil((((box.x1 - c) * inset + c) / VB) * S) + 2);
    const y0 = Math.max(0, Math.floor((((box.y0 - c) * inset + c) / VB) * S) - 2);
    const y1 = Math.min(S - 1, Math.ceil((((box.y1 - c) * inset + c) / VB) * S) + 2);

    for (let py = y0; py <= y1; py++) {
      // Undo the inset so the shape is tested in its own coordinate system.
      const uy = (toUser(py) - c) / inset + c;
      for (let px = x0; px <= x1; px++) {
        const ux = (toUser(px) - c) / inset + c;
        if (!hits(shape, ux, uy)) continue;

        const i = (py * S + px) * 4;
        const a = shape.alpha;
        buf[i] = shape.fill[0] * a + buf[i] * (1 - a);
        buf[i + 1] = shape.fill[1] * a + buf[i + 1] * (1 - a);
        buf[i + 2] = shape.fill[2] * a + buf[i + 2] * (1 - a);
        buf[i + 3] = 255 * a + buf[i + 3] * (1 - a);
      }
    }
  }

  // --- downsample ---------------------------------------------------------
  const out = new Uint8ClampedArray(size * size * 4);
  const n = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const i = ((y * ss + sy) * S + (x * ss + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const o = (y * size + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

/** Axis-aligned bounds in viewBox units, accounting for rotation. */
function boundsOf(shape) {
  if (shape.kind === 'poly') {
    const xs = shape.points.map((p) => p[0]);
    const ys = shape.points.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  const corners = [
    [shape.x, shape.y],
    [shape.x + shape.w, shape.y],
    [shape.x + shape.w, shape.y + shape.h],
    [shape.x, shape.y + shape.h],
  ];
  if (!shape.rotate) {
    return { x0: shape.x, x1: shape.x + shape.w, y0: shape.y, y1: shape.y + shape.h };
  }

  const a = (shape.rotate.deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const pts = corners.map(([x, y]) => {
    const ox = x - shape.rotate.cx;
    const oy = y - shape.rotate.cy;
    return [ox * cos - oy * sin + shape.rotate.cx, ox * sin + oy * cos + shape.rotate.cy];
  });
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Flat colour square, still needed for the native splash. */
function solid(size, [r, g, b]) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
  }
  return out;
}

// ------------------------------------------------------------------- write --

mkdirSync('assets', { recursive: true });
mkdirSync('public', { recursive: true });

const targets = [
  ['assets/icon.png', 1024, { rounded: true }],
  ['assets/favicon.png', 48, { rounded: true }],
  ['public/icon-192.png', 192, { rounded: true }],
  ['public/icon-512.png', 512, { rounded: true }],
  // Android crops maskable icons to a circle, so the artwork is inset into the
  // safe zone while the background still bleeds to the edge.
  ['public/icon-512-maskable.png', 512, { rounded: false, inset: 0.78 }],
  // iOS masks home-screen icons itself — square background, no baked corners.
  ['public/apple-touch-icon.png', 180, { rounded: false }],
  ['public/favicon.png', 48, { rounded: true }],
];

for (const [path, size, opts] of targets) {
  writeFileSync(path, encodePng(size, drawIcon(size, opts)));
  console.log(`wrote ${path} (${size}x${size})`);
}

// The native splash stays a flat colour; app.json sets its background to white.
writeFileSync('assets/splash.png', encodePng(512, solid(512, [255, 255, 255])));
console.log('wrote assets/splash.png (512x512)');
