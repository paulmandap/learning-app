import { memo } from 'react';
import { View } from 'react-native';
import { iconFill, iconPieces, strokeLayout, type Bar, type Dot, type Polyline } from '../core/icon-geometry';
import type { IconName } from '../core/icon-shapes';

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
 * One icon, drawn with Views (NOTES §56.2).
 *
 * The owner chose this over an icon package or SVG: *"try harder. draw
 * boxes."* The shapes are Lucide's (src/core/icon-shapes.ts, generated), and
 * src/core/icon-geometry.ts breaks each into what a View can be — a ring, a
 * rounded frame, a dot, or a bar turned to its angle. Curves are runs of short
 * square-ended bars meeting end to end, with round dots at the ends and sharp
 * corners (`strokeLayout`, and why not round-ended bars: NOTES §57).
 *
 * The stroke is 1.75 at 24 and never thinner than 1.5, so a 16 px icon beside
 * a time stamp does not turn to hairlines. `filled` fills a closed shape — a
 * liked heart, a saved bookmark — and still draws the outline over the fill,
 * which is what hides the bands' stepped edges.
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
  const sw = Math.max(1.5, STROKE * k);
  const { lines, rings, frames } = iconPieces(name);
  const strokes = strokesOf(name, lines, sw / k);
  let key = 0;

  return (
    <View
      style={{ width: size, height: size }}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {filled
        ? iconFill(name).map(([x, y, w, h]) => (
            <View
              key={key++}
              style={{ position: 'absolute', left: x * k, top: y * k, width: w * k, height: h * k, backgroundColor: color }}
            />
          ))
        : null}
      {frames.map((f) => (
        <View
          key={key++}
          style={{
            position: 'absolute',
            left: f.x * k - sw / 2,
            top: f.y * k - sw / 2,
            width: f.w * k + sw,
            height: f.h * k + sw,
            borderRadius: f.r * k + sw / 2,
            borderWidth: sw,
            borderColor: color,
            backgroundColor: filled ? color : undefined,
          }}
        />
      ))}
      {rings.map((c) => {
        const d = 2 * c.r * k + sw;
        // A circle not much wider than its own line — the three dots of ⋯ —
        // is a solid dot in SVG, where the stroke covers the middle. As a
        // border it left a pin-prick hole, and ⋯ read as ∘∘∘ in the first
        // photograph of the feed.
        const dot = 2 * c.r * k <= sw * 1.5;
        return (
          <View
            key={key++}
            style={{
              position: 'absolute',
              left: c.cx * k - d / 2,
              top: c.cy * k - d / 2,
              width: d,
              height: d,
              borderRadius: d / 2,
              borderWidth: dot ? 0 : sw,
              borderColor: color,
              backgroundColor: dot ? color : undefined,
            }}
          />
        );
      })}
      {strokes.bars.map((b) => (
        <View
          key={key++}
          style={{
            position: 'absolute',
            left: b.cx * k - (b.length * k) / 2,
            top: b.cy * k - sw / 2,
            width: b.length * k,
            height: sw,
            backgroundColor: color,
            transform: [{ rotate: `${b.angle}deg` }],
          }}
        />
      ))}
      {strokes.dots.map((d) => (
        <View
          key={key++}
          style={{
            position: 'absolute',
            left: d.cx * k - sw / 2,
            top: d.cy * k - sw / 2,
            width: sw,
            height: sw,
            borderRadius: sw / 2,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
});

const layoutCache = new Map<string, { bars: Bar[]; dots: Dot[] }>();

/**
 * Every bar and dot of an icon's lines at one stroke, in icon units — worked
 * out once per icon and size, since a feed draws the same heart twenty times.
 */
function strokesOf(name: IconName, lines: readonly Polyline[], width: number) {
  const key = `${name}:${width.toFixed(3)}`;
  let found = layoutCache.get(key);
  if (!found) {
    const bars: Bar[] = [];
    const dots: Dot[] = [];
    for (const line of lines) {
      const l = strokeLayout(line, width);
      bars.push(...l.bars);
      dots.push(...l.dots);
    }
    found = { bars, dots };
    layoutCache.set(key, found);
  }
  return found;
}

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
