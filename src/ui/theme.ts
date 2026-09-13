import { useColorScheme } from 'react-native';
import { DARK, LIGHT, type ChartPalette, type Theme } from '../core/palette';

export type { ChartPalette, Theme };

/**
 * Theme follows the device. No in-app toggle, no theming framework — two token
 * objects and a hook is the whole system for eight screens.
 */

/**
 * Exported so `scripts/palette-check.ts` validates THE SHIPPED VALUES.
 *
 * A validator that reads its own copy of the palette proves nothing — the
 * same mistake the backup's hand-kept table list made four times over.
 */
/** Both palettes, for anything that needs them outside a component. */
export const THEMES = { light: LIGHT, dark: DARK } as const;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
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
  /** Optical nudges. Named so they stop being invented per file: the audit
   *  found 2, 3, 5, 6 and 10 used as one-off gaps nobody could repeat. */
  hair: 2,
  tight: 6,
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
  /** Body at list-row weight. `ListRow` hand-rolled this; now it is a step. */
  bodyStrong: { fontSize: 15, fontWeight: '600' as const, lineHeight: 22 },
  /** Button labels. Was a bare 16/600 inside the stylesheet. */
  button: { fontSize: 16, fontWeight: '600' as const, lineHeight: 20 },
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

/**
 * Elevation: there isn't any, and that is the system.
 *
 * Every surface in this app is flat with a 1px hairline. No shadows anywhere.
 * That was already true and was never written down, which is how a system
 * gets violated — the next person adds one shadow and nothing says no.
 *
 * Exactly ONE thing floats: the assistant ✦. It gets a named layer rather than
 * a number sprinkled at a call site.
 */
export const elevation = {
  /** The only floating layer in the app. */
  float: 30,
} as const;

/**
 * How much room a screen must leave at the bottom for the floating ✦.
 *
 * This is a defect fix promoted to a token. `Screen` used to pad the bottom by
 * 48 while the ✦ occupies its own height plus a gap plus the safe-area inset —
 * so on Settings the button sat on top of "Test connection" and covered a real
 * control (NOTES §35). Padding by a number that had nothing to do with the
 * thing it was avoiding is why it drifted.
 *
 * The safe-area inset is added by the caller, which is the only place that
 * knows it.
 */
export const FLOAT_SIZE = 56;
export const FLOAT_CLEARANCE = FLOAT_SIZE + space.xl;

/**
 * The tab bar's height, owned HERE rather than reconstructed.
 *
 * `assistant.tsx` used to rebuild this as `space.xs + 44` from a layout it
 * does not own, so changing the bar would silently misplace the ✦.
 */
export const TAB_BAR_HEIGHT = space.xs + TOUCH_TARGET;
