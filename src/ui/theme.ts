import { useColorScheme } from 'react-native';

/**
 * Theme follows the device. No in-app toggle, no theming framework — two token
 * objects and a hook is the whole system for eight screens.
 */

export interface Theme {
  bg: string;
  card: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentText: string;
  danger: string;
  ok: string;
  warnBg: string;
  warnText: string;
  /** Fills for the Progress screen. See the note above `chartLight`. */
  chart: ChartPalette;
}

/**
 * Chart fills, kept separate from the UI tokens on purpose.
 *
 * A colour that works as text or as a hairline is not a colour that works as a
 * FILL, and using the UI tokens for both was measurably wrong. Run through the
 * dataviz validator, the first attempt — reusing `border` for "Not started" and
 * `warnText` for "Tricky" — failed on contrast at **1.27:1** against the card.
 * That segment was effectively invisible.
 *
 * These steps are validated: every fill clears 3:1 against its surface, and the
 * worst adjacent pair separates by ΔE 16.1 under deuteranopia (light) and 17.1
 * under protanopia (dark). They are CHOSEN per mode rather than flipped — a
 * light-mode fill on a dark card fails contrast in the other direction.
 *
 * `neutral` is deliberately grey and deliberately fails the validator's chroma
 * floor: it means "no data yet", and an absence should not wear a hue. Identity
 * never rests on colour alone here anyway — every segment is labelled in text.
 */
export interface ChartPalette {
  /** Cards on a long interval — the good state. */
  known: string;
  /** Cards in progress. */
  learning: string;
  /** Cards repeatedly failed. */
  tricky: string;
  /** Never answered. Grey by intent. */
  neutral: string;
  /** Single-series marks: the activity columns. */
  series: string;
}

const light: Theme = {
  bg: '#f7f7f8',
  card: '#ffffff',
  text: '#16181d',
  textMuted: '#5c6270',
  border: '#dfe1e6',
  accent: '#2f5fe0',
  accentText: '#ffffff',
  danger: '#b3261e',
  ok: '#1d7a4c',
  warnBg: '#fff6e5',
  warnText: '#6b4a00',
  chart: {
    known: '#1d7a4c',
    learning: '#2f5fe0',
    tricky: '#a86a00',
    neutral: '#8c93a1',
    series: '#2f5fe0',
  },
};

const dark: Theme = {
  bg: '#111318',
  card: '#1a1d24',
  text: '#eceef2',
  textMuted: '#9aa1ad',
  // Raised from #2b2f39. Card surfaces sit on a near-black ground, and at the
  // old value the edge measured 1.26:1 against the card — invisible on an OLED
  // screen, so rows and cards had no defined shape.
  //
  // Worth recording: the suggestion that prompted this was "1px solid
  // rgba(255,255,255,0.08)". Composited over the card that resolves to #2c2f36,
  // which is the value already in place — it would have changed nothing. This
  // is roughly 0.20 opacity, measured at 1.90:1.
  border: '#484a50',
  accent: '#7ea0ff',
  accentText: '#0d1117',
  danger: '#f2b8b5',
  ok: '#7ad6a5',
  warnBg: '#2e2413',
  warnText: '#f2d9a3',
  chart: {
    known: '#7ad6a5',
    learning: '#7ea0ff',
    tricky: '#e0a458',
    neutral: '#7c8492',
    series: '#7ea0ff',
  },
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

/**
 * Desktop uses a centred content column; mobile fills the width.
 *
 * 560 rather than 720. At 720 a full-width button stopped reading as a button
 * and became a banner — wide and short — and the screens looked like a phone
 * layout stretched to fit. Narrowing the column fixes that for every element at
 * once, which is the right lever: capping button width alone was tried and left
 * buttons narrower than the cards stacked directly above them.
 */
export const CONTENT_MAX_WIDTH = 560;

/**
 * Design tokens.
 *
 * Deliberately small. Eight screens do not need a design system, but they do
 * need spacing and type to come from one place — the previous ad-hoc values
 * were why the app read as a form rather than a product.
 */

/** 4px base scale. Use these rather than raw numbers. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
  pill: 999,
  /**
   * Buttons specifically. Softer than the 8px they used to share with inputs —
   * at that radius a full-width button reads as a form field rather than
   * something to tap.
   */
  button: 16,
} as const;

/**
 * Type scale. `card` is deliberately large: a flashcard prompt is the one
 * thing on screen and should read comfortably at arm's length.
 */
export const type = {
  display: { fontSize: 28, fontWeight: '700' as const, lineHeight: 34 },
  title: { fontSize: 22, fontWeight: '600' as const, lineHeight: 28 },
  card: { fontSize: 20, fontWeight: '500' as const, lineHeight: 28 },
  /**
   * The question face. Same size and rhythm as `card`, heavier weight — the
   * weight is what says "this is being asked of you" at a glance, so a card
   * caught mid-flip is never ambiguous about which side you are looking at.
   * Answers stay at `card` weight, and the contrast is the signal.
   */
  cardPrompt: { fontSize: 20, fontWeight: '700' as const, lineHeight: 28 },
  body: { fontSize: 15, fontWeight: '400' as const, lineHeight: 22 },
  label: { fontSize: 13, fontWeight: '500' as const, lineHeight: 18 },
  caption: { fontSize: 12, fontWeight: '400' as const, lineHeight: 16 },
} as const;

/**
 * Minimum interactive size.
 *
 * 44px is Apple's guidance and the practical floor for a thumb — the study
 * buttons get pressed hundreds of times per session, so this is not cosmetic.
 */
export const TOUCH_TARGET = 44;

/**
 * Smallest text an input may use. **Never lower this.**
 *
 * iOS Safari force-zooms the page when a field with text under 16px takes
 * focus, and it does not zoom back out afterwards. The owner hit this on an
 * iPhone: tapping the assistant zoomed the app, and swiping around the zoomed
 * page revealed blank canvas outside it. The field was 15px.
 *
 * The other fix — `maximum-scale=1, user-scalable=no` in the viewport meta —
 * is deliberately NOT used: it takes pinch-zoom away from everyone who needs it
 * to read at all, to save one point of font size.
 *
 * Neither the test suite nor the screenshot harness can see this: headless
 * Chrome on Windows has no such rule. `tests/input-zoom.test.ts` reads the
 * source instead, which is the only check that would have caught it.
 */
export const INPUT_FONT_SIZE = 16;

/** Swipe feedback colours, independent of light/dark palette roles. */
export const swipeTint = {
  gotIt: '#1d7a4c',
  missed: '#b3822a',
} as const;
