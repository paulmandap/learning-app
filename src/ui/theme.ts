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
};

const dark: Theme = {
  bg: '#111318',
  card: '#1a1d24',
  text: '#eceef2',
  textMuted: '#9aa1ad',
  border: '#2b2f39',
  accent: '#7ea0ff',
  accentText: '#0d1117',
  danger: '#f2b8b5',
  ok: '#7ad6a5',
  warnBg: '#2e2413',
  warnText: '#f2d9a3',
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

/** Desktop uses a centred content column; mobile fills the width. */
export const CONTENT_MAX_WIDTH = 720;

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
} as const;

/**
 * Type scale. `card` is deliberately large: a flashcard prompt is the one
 * thing on screen and should read comfortably at arm's length.
 */
export const type = {
  display: { fontSize: 28, fontWeight: '700' as const, lineHeight: 34 },
  title: { fontSize: 22, fontWeight: '600' as const, lineHeight: 28 },
  card: { fontSize: 20, fontWeight: '500' as const, lineHeight: 28 },
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

/** Swipe feedback colours, independent of light/dark palette roles. */
export const swipeTint = {
  gotIt: '#1d7a4c',
  missed: '#b3822a',
} as const;
