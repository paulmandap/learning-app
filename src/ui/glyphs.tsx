import { View } from 'react-native';

/**
 * Every symbol the app draws, in one place.
 *
 * ## Text glyphs
 *
 * The app has no icon set — `@expo/vector-icons` is not installed, and a
 * handful of chevrons is not a reason to add it. So symbols are Unicode, and
 * they used to be typed inline wherever they were needed: ›, ‹, ⋯, ✕, ✓, ✗ and
 * ✦ across six files. That is how two chevrons end up being two different
 * characters. Now each has a name, and `tests/screens.test.ts` fails a screen
 * that types one in directly.
 */
export const GLYPH = {
  /** U+203A. Goes somewhere — a list row. */
  forward: '›',
  /** U+2039. The header back control. */
  back: '‹',
  /** U+22EF. Renders as text everywhere, unlike an emoji ellipsis. */
  more: '⋯',
  close: '✕',
  /** Right and wrong carry a mark as well as a colour — never hue alone. */
  right: '✓',
  wrong: '✗',
  /** Nomi's mark: the floating ask button. */
  nomi: '✦',
  /** Send a message. */
  send: '↑',
  /** Past conversations. */
  history: '☰',
  /** Start a new conversation. */
  newChat: '✎',
} as const;

export type TabIconName = 'study' | 'notes' | 'progress' | 'settings';

const BOX = 22;
const STROKE = 1.75;

/**
 * The four tab icons, drawn rather than typed.
 *
 * ## Why these are Views and not characters
 *
 * The tabs were ✎ ❏ ◕ ⚙︎ — four characters from four corners of Unicode, which
 * a font draws at four unrelated weights and optical sizes: a heavy pencil, a
 * hairline square, a solid pie, a thin gear (NOTES §35). They also look
 * different on every platform, because each one comes from whatever font the
 * device falls back to — the gear becomes an emoji on some.
 *
 * Built from Views, all four share one 22pt box and one stroke, and look the
 * same on an iPhone as in the screenshot harness. No SVG, which this project
 * does not have, and no icon font, which would be a dependency.
 *
 * `ground` is the colour behind the icon. Two of them overlap a shape on top
 * of a line — the front card, the slider knobs — and the overlapping shape is
 * filled with the ground so the line behind it is hidden.
 */
export function TabIcon({
  name,
  color,
  ground,
}: {
  name: TabIconName;
  color: string;
  ground: string;
}) {
  const outline = { position: 'absolute' as const, borderWidth: STROKE, borderColor: color };
  const solid = { position: 'absolute' as const, backgroundColor: color, borderRadius: 1 };

  return (
    <View
      style={{ width: BOX, height: BOX }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {name === 'study' ? (
        // Two cards, one behind the other: what a set is.
        <>
          <View style={[outline, { left: 8, top: 2, width: 12, height: 15, borderRadius: 3 }]} />
          <View
            style={[
              outline,
              { left: 3, top: 5, width: 12, height: 15, borderRadius: 3, backgroundColor: ground },
            ]}
          />
        </>
      ) : name === 'notes' ? (
        // A page with writing on it.
        <>
          <View style={[outline, { left: 4, top: 2, width: 14, height: 18, borderRadius: 3 }]} />
          <View style={[solid, { left: 7.5, top: 7, width: 7, height: STROKE }]} />
          <View style={[solid, { left: 7.5, top: 10.5, width: 7, height: STROKE }]} />
          <View style={[solid, { left: 7.5, top: 14, width: 4.5, height: STROKE }]} />
        </>
      ) : name === 'progress' ? (
        // Three rising bars. Thin enough to carry the same ink as a stroke.
        <>
          <View style={[solid, { left: 3, bottom: 3, width: 4, height: 7 }]} />
          <View style={[solid, { left: 9, bottom: 3, width: 4, height: 11 }]} />
          <View style={[solid, { left: 15, bottom: 3, width: 4, height: 16 }]} />
        </>
      ) : (
        // Two sliders — settings you adjust, which a gear only implies.
        <>
          <View style={[solid, { left: 2, top: 6, width: 18, height: STROKE }]} />
          <View style={[solid, { left: 2, top: 15, width: 18, height: STROKE }]} />
          <View
            style={[
              outline,
              { left: 11, top: 3, width: 7.5, height: 7.5, borderRadius: 4, backgroundColor: ground },
            ]}
          />
          <View
            style={[
              outline,
              { left: 4, top: 12, width: 7.5, height: 7.5, borderRadius: 4, backgroundColor: ground },
            ]}
          />
        </>
      )}
    </View>
  );
}
