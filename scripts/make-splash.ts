/**
 * Nomi for the splash in `public/index.html` (NOTES §42, §43).
 *
 *   npx tsx scripts/make-splash.ts
 *
 * Copies the five layers the character is animated from (`assets/nomi-*.webp`,
 * cut by `scripts/make-nomi-assets.ts`) to `public/nomi/`, where plain HTML can
 * reach them by a fixed name, and writes where they attach — pivots, eye lines,
 * eye radius — into the marked block in `public/index.html`, from the same
 * `NOMI_RIG` the app uses. Re-cut Nomi, then run this.
 *
 * It used to compose one still picture (§42). The owner asked for the splash to
 * show Nomi doing something — "waving/greeting, studying/focused", a different
 * one each time — and a still picture cannot move its wings, so the splash now
 * stacks the layers and animates them in CSS.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOMI_RIG } from '../src/ui/nomi-rig';
import { withSplashRig } from '../src/core/splash';

const LAYERS: Record<string, string> = {
  'nomi-body.webp': 'body.webp',
  'nomi-eye-left.webp': 'eye-left.webp',
  'nomi-eye-right.webp': 'eye-right.webp',
  'nomi-wing-left.webp': 'wing-left.webp',
  'nomi-wing-right.webp': 'wing-right.webp',
};
const OUT_DIR = join('public', 'nomi');
const PAGE = join('public', 'index.html');
/** The still picture §42 made. Nothing reads it now. */
const RETIRED = join('public', 'nomi-splash.webp');

mkdirSync(OUT_DIR, { recursive: true });
for (const [from, to] of Object.entries(LAYERS)) {
  copyFileSync(join('assets', from), join(OUT_DIR, to));
  console.log(`  ${join(OUT_DIR, to)}`);
}
if (existsSync(RETIRED)) {
  rmSync(RETIRED);
  console.log(`  removed ${RETIRED}`);
}

const html = readFileSync(PAGE, 'utf8');
const next = withSplashRig(html, NOMI_RIG);
writeFileSync(PAGE, next);
console.log(`  ${PAGE} ${next === html ? '(rig unchanged)' : '(rig written)'}`);
