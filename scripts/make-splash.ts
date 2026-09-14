/**
 * Nomi at rest, as one picture, for the splash in `public/index.html` (NOTES §42).
 *
 *   npx tsx scripts/make-splash.ts
 *
 * Composed from the layers the character is animated from
 * (`assets/nomi-*.webp`, cut by `scripts/make-nomi-assets.ts`), stacked in the
 * order `src/ui/nomi-character.tsx` draws them. So the owl on the splash is the
 * owl the app then shows, pixel for pixel — re-cut Nomi, then run this.
 *
 * A picture of its own rather than the layers themselves, because the splash
 * is plain HTML shown before any JavaScript has loaded: it cannot stack and
 * register five images, and one small file is the fastest thing to paint.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCanvasPage } from './chrome-canvas';

/** Bottom to top, as the character draws them. */
const LAYERS = [
  'nomi-body.webp',
  'nomi-eye-left.webp',
  'nomi-eye-right.webp',
  'nomi-wing-left.webp',
  'nomi-wing-right.webp',
];
const OUT = join('public', 'nomi-splash.webp');
const QUALITY = 0.92;

async function main() {
  const uris = LAYERS.map((name) => `data:image/webp;base64,${readFileSync(join('assets', name)).toString('base64')}`);
  const page = await openCanvasPage('splash');
  try {
    const result = await page.evaluate<{ uri: string; width: number; height: number }>(
      `(async (uris, quality) => {
        const images = await Promise.all(uris.map(async (src) => { const i = new Image(); i.src = src; await i.decode(); return i; }));
        const w = images[0].naturalWidth, h = images[0].naturalHeight;
        for (const i of images) if (i.naturalWidth !== w || i.naturalHeight !== h) throw new Error('layers are not the same size');
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        for (const i of images) g.drawImage(i, 0, 0);
        return { uri: c.toDataURL('image/webp', quality), width: w, height: h };
      })(${JSON.stringify(uris)}, ${QUALITY})`,
    );
    const bytes = Buffer.from(result.uri.split(',')[1]!, 'base64');
    writeFileSync(OUT, bytes);
    console.log(`  ${OUT}  ${result.width}x${result.height}  ${(bytes.length / 1024).toFixed(1)} KB`);
  } finally {
    page.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
