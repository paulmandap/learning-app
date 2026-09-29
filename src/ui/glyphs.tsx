import { memo } from 'react';
import { View } from 'react-native';
import { ICON_SHAPES, type IconName } from '../core/icon-shapes';

export type { IconName };

/**
 * Every symbol the app draws, in one place.
 *
 * ## Icons, and the few text glyphs left
 *
 * A control's symbol is an `Icon` (below). The characters here are for marks
 * INSIDE text — "✓ Cat", "Open it ›", the ⋯ named in a sentence — where a
 * drawn icon would sit off the line.
 *
 * They used to be typed inline wherever they were needed: ›, ‹, ⋯, ✕, ✓, ✗ and
 * ✦ across six files. That is how two chevrons end up being two different
 * characters. Now each has a name, and `tests/screens.test.ts` fails a screen
 * that types one in directly. The ones that were controls — back, close, send,
 * history, new chat, edit, react — became icons in NOTES §56.3.
 */
export const GLYPH = {
  /** U+203A. Goes somewhere, said in words — "Open it ›". */
  forward: '›',
  /** U+22EF. Renders as text everywhere, unlike an emoji ellipsis. */
  more: '⋯',
  /** Right and wrong carry a mark as well as a colour — never hue alone. */
  right: '✓',
  wrong: '✗',
  /** Nomi's mark: the floating ask button. */
  nomi: '✦',
} as const;

/**
 * One icon, drawn as SVG (NOTES §66).
 *
 * The shapes are Lucide's (src/core/icon-shapes.ts, generated), drawn as they
 * are — a path, a circle, a rectangle, a line — in a 24-unit box, by the
 * browser. react-native-web renders to the page, so a plain `<svg>` needs no
 * package (measured in §56.1: about 1 KB).
 *
 * They were drawn with Views from §56.2 to §65 — the owner's choice then,
 * *"try harder. draw boxes."* — every curve a run of short bars. The browser
 * smooths each bar's edges on its own, so where bars met the edge was drawn
 * twice, and on a computer screen the curves came out lumpy. The owner, with
 * a post's heart, comment and share: *"the icons look bad it looks weird like
 * 144p"*; asked, he chose SVG. It is web-only; the app ships only as a PWA.
 *
 * The stroke is 1.75 at 24 and never thinner than 1.5 on screen, so a 16 px
 * icon beside a time stamp does not turn to hairlines. `filled` fills the
 * shape — a liked heart, a saved bookmark — under the same outline.
 *
 * Always decorative: the control it sits in carries the words.
 */
export const Icon = memo(function Icon({
  name,
  color,
  size = 24,
  filled = false,
}: {
  name: IconName;
  color: string;
  size?: number;
  filled?: boolean;
}) {
  const k = size / 24;
  // In the box's own units, so the line is the same on screen at any size.
  const stroke = Math.max(1.5, STROKE * k) / k;

  return (
    <View
      style={{ width: size, height: size }}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={filled ? color : 'none'}
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        focusable="false"
        style={{ display: 'block' }}
      >
        {ICON_SHAPES[name].map((s, i) =>
          s[0] === 'p' ? (
            <path key={i} d={s[1]} />
          ) : s[0] === 'c' ? (
            <circle key={i} cx={s[1]} cy={s[2]} r={s[3]} />
          ) : s[0] === 'r' ? (
            <rect key={i} x={s[1]} y={s[2]} width={s[3]} height={s[4]} rx={s[5]} />
          ) : (
            <line key={i} x1={s[1]} y1={s[2]} x2={s[3]} y2={s[4]} />
          ),
        )}
      </svg>
    </View>
  );
});

/**
 * Lucide's stroke at 24, a touch lighter than its default 2 — the owner's
 * picture asked for 1.75, and so did the tab icons this set replaced.
 *
 * Those were `TabIcon`: four hand-placed drawings (two cards, a page, two
 * people, three bars) that replaced four unrelated Unicode characters (NOTES
 * §35). `Icon` does the same job for every icon from one set of shapes, so the
 * tab bar, the headers and the sheets now share one hand (NOTES §56.3).
 */
const STROKE = 1.75;
