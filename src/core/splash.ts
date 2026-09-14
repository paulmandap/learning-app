/**
 * The splash's Nomi: where its moving parts attach, as CSS (NOTES §43).
 *
 * Pure. The splash in `public/index.html` is plain HTML and CSS, shown before
 * any JavaScript has loaded, so it cannot read `NOMI_RIG` at run time. Instead
 * `scripts/make-splash.ts` writes this block between two markers in that file,
 * from the same rig the character component uses — and `tests/splash.test.ts`
 * fails if the file and the rig ever disagree.
 *
 * The owl on the splash is drawn at a fixed size, so the eye radius is in
 * pixels; the pivots and eye lines are percentages of the layer, exactly as the
 * rig stores them as fractions.
 */

/** The splash owl's width in CSS pixels. Its height follows the art. */
export const SPLASH_NOMI_WIDTH = 132;

export const SPLASH_RIG_START = '<!-- NOMI SPLASH RIG START: written by scripts/make-splash.ts, do not edit by hand -->';
export const SPLASH_RIG_END = '<!-- NOMI SPLASH RIG END -->';

/** The variants the splash picks between. Never idle: the owner asked for Nomi doing something. */
export const SPLASH_VARIANTS = ['greeting', 'studying', 'thinking', 'explaining'] as const;

export interface SplashRigInput {
  width: number;
  height: number;
  wingLeftPivot: readonly [number, number];
  wingRightPivot: readonly [number, number];
  eyeLeftLine: number;
  eyeRightLine: number;
  eyeRadius: number;
}

const pct = (fraction: number) => `${Math.round(fraction * 10000) / 100}%`;
const px = (value: number) => `${Math.round(value * 100) / 100}px`;

/** The owl's height at the splash width, whole pixels. */
export function splashNomiHeight(rig: Pick<SplashRigInput, 'width' | 'height'>): number {
  return Math.round((SPLASH_NOMI_WIDTH * rig.height) / rig.width);
}

/** The generated block, markers included, exactly as it sits in index.html. */
export function splashRigBlock(rig: SplashRigInput): string {
  const vars = [
    `--nomi-width: ${px(SPLASH_NOMI_WIDTH)};`,
    `--nomi-height: ${px(splashNomiHeight(rig))};`,
    `--wing-left-x: ${pct(rig.wingLeftPivot[0])};`,
    `--wing-left-y: ${pct(rig.wingLeftPivot[1])};`,
    `--wing-right-x: ${pct(rig.wingRightPivot[0])};`,
    `--wing-right-y: ${pct(rig.wingRightPivot[1])};`,
    `--eye-left-line: ${pct(rig.eyeLeftLine)};`,
    `--eye-right-line: ${pct(rig.eyeRightLine)};`,
    `--eye-radius: ${px(rig.eyeRadius * SPLASH_NOMI_WIDTH)};`,
  ];
  return [
    `    ${SPLASH_RIG_START}`,
    '    <style id="splash-rig">',
    `      #splash { ${vars.join(' ')} }`,
    '    </style>',
    `    ${SPLASH_RIG_END}`,
  ].join('\n');
}

/** Replace the generated block in a page. Throws if the markers are missing, rather than quietly doing nothing. */
export function withSplashRig(html: string, rig: SplashRigInput): string {
  const start = html.indexOf(`    ${SPLASH_RIG_START}`);
  const end = html.indexOf(SPLASH_RIG_END);
  if (start < 0 || end < 0 || end < start) throw new Error('index.html has no splash rig markers');
  return html.slice(0, start) + splashRigBlock(rig) + html.slice(end + SPLASH_RIG_END.length);
}
