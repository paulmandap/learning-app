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

// ------------------------------------------------------------- when it goes --

/**
 * The shortest the splash stays, from the start of the page load.
 *
 * On a cached reload the app knows who is signed in within a few tens of
 * milliseconds, and a splash that blinks for one frame reads as a glitch, not
 * as Nomi saying hello. 1400ms (NOTES §43): long enough for one whole wave or
 * gesture, which peaks a little after a second.
 */
export const SPLASH_MIN_MS = 1400;

/**
 * The longest the splash waits for the first screen's data once the app knows
 * who is signed in. A slow network must never hold anyone on a splash: past
 * this, whatever has loaded is shown and the rest arrives on screen.
 */
export const SPLASH_DATA_WAIT_MS = 5000;

/**
 * How long nothing may be loading before the first screen counts as ready.
 * One answer often starts the next request — the profile, then its picture —
 * and there is a moment between the two when nothing is.
 */
export const SPLASH_SETTLE_MS = 150;

/** Signed in, and nothing has started loading this long after: a screen with nothing to fetch. */
export const SPLASH_NOTHING_TO_LOAD_MS = 400;

export interface SplashMoment {
  /** Milliseconds since the page began loading. */
  sinceLoad: number;
  /** Milliseconds since the app knew whether anyone is signed in; null until it does. */
  sinceReady: number | null;
  signedIn: boolean;
  /** Requests for the app's data in flight right now. */
  fetching: number;
  /** How long nothing has been in flight; 0 while something is. */
  idleFor: number;
  /** Whether anything has been fetched since the app knew who is signed in. */
  sawWork: boolean;
}

/**
 * Whether the splash may go now (NOTES §45).
 *
 * The owner: *"it would be cool while in a splash, the app itself will load
 * too, saving users time."* Measured first, it already did — the bundle, the
 * session and Home's requests all ran behind the splash. What was wrong is what
 * the splash waited for: only whether anyone is signed in. On a warm load
 * Home's sets were there at about 0.7s and the splash stayed to 1.4s anyway;
 * on a cold, throttled one the app was ready late and the splash went at once,
 * onto "Loading…", with the sets arriving after.
 *
 * So it now goes when the first screen has what it asked for: nothing in flight
 * for a moment after something was, never before one gesture has played, and
 * never later than `SPLASH_DATA_WAIT_MS` after the app knew who is signed in.
 */
export function shouldHideSplash(m: SplashMoment): boolean {
  if (m.sinceReady === null) return false;
  if (m.sinceLoad < SPLASH_MIN_MS) return false;
  // Sign-in has nothing to load.
  if (!m.signedIn) return true;
  if (m.sinceReady >= SPLASH_DATA_WAIT_MS) return true;
  if (m.fetching > 0) return false;
  if (!m.sawWork) return m.sinceReady >= SPLASH_NOTHING_TO_LOAD_MS;
  return m.idleFor >= SPLASH_SETTLE_MS;
}

/** Replace the generated block in a page. Throws if the markers are missing, rather than quietly doing nothing. */
export function withSplashRig(html: string, rig: SplashRigInput): string {
  const start = html.indexOf(`    ${SPLASH_RIG_START}`);
  const end = html.indexOf(SPLASH_RIG_END);
  if (start < 0 || end < 0 || end < start) throw new Error('index.html has no splash rig markers');
  return html.slice(0, start) + splashRigBlock(rig) + html.slice(end + SPLASH_RIG_END.length);
}
