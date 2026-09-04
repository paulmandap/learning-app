/**
 * Generates placeholder PNG icons with no image dependencies.
 *
 * These are flat colour squares standing in for real artwork — enough for the
 * PWA manifest to validate and for the web build to succeed. Replace them with
 * designed icons before anyone installs this to a home screen.
 *
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

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

/** Solid RGBA square as a valid PNG. */
function png(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = compression, filter, interlace = 0

  // Each scanline is prefixed with a filter byte (0 = none).
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x++) {
    row[1 + x * 4] = r;
    row[2 + x * 4] = g;
    row[3 + x * 4] = b;
    row[4 + x * 4] = 255;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ACCENT = [47, 95, 224]; // matches theme.accent
const WHITE = [255, 255, 255];

mkdirSync('assets', { recursive: true });
mkdirSync('public', { recursive: true });

const targets = [
  ['assets/icon.png', 1024, ACCENT],
  ['assets/favicon.png', 48, ACCENT],
  ['public/icon-192.png', 192, ACCENT],
  ['public/icon-512.png', 512, ACCENT],
  ['public/icon-512-maskable.png', 512, ACCENT],
  ['public/apple-touch-icon.png', 180, ACCENT],
  ['public/favicon.png', 48, ACCENT],
  ['assets/splash.png', 512, WHITE],
];

for (const [path, size, colour] of targets) {
  writeFileSync(path, png(size, colour));
  console.log(`wrote ${path} (${size}x${size})`);
}
