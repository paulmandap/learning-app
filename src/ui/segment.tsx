import { Pressable, Text, View } from 'react-native';
import { radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import type { Level } from '../core/planner';

/**
 * The Remember / Understand / Apply picker, in one place.
 *
 * ## Why this exists
 *
 * It was declared three times — `flashcards.tsx`, `quiz.tsx`, `blanks.tsx` —
 * with near-identical JSX in two of them, and the copies had already drifted
 * once: §23.2 records the quiz shipping without its counts while the other two
 * had them, so a button promising ten dealt three. Three copies of a control
 * this central is a defect waiting to recur.
 *
 * ## Why it is not three Buttons
 *
 * It used to be. `Button` is for actions; this is a picker, and rendering it
 * as three full-width primary/secondary buttons is why the counts had to be
 * concatenated into the label — `"Remember 5"` as one string, which wrapped to
 * two lines while `"Apply 4"` did not.
 *
 * Here the count is a separate element, so a long label wraps without dragging
 * its number with it, and the selected rung reads as *selected within a group*
 * rather than as the one primary action on the screen.
 *
 * Levels are EXCLUSIVE (a deliberate reversal of D2), and the counts are what
 * make that honest: you can see a level is nearly empty before you pick it.
 */

export const LEVELS: { key: Level; label: string }[] = [
  { key: 'remember', label: 'Remember' },
  { key: 'understand', label: 'Understand' },
  { key: 'apply', label: 'Apply' },
];

export function LevelSegment({
  value,
  counts,
  onChange,
}: {
  value: Level;
  /** How many cards each level would actually deal. */
  counts: Partial<Record<Level, number>>;
  onChange: (level: Level) => void;
}) {
  const t = useTheme();

  return (
    <View style={{ flexDirection: 'row', gap: space.sm }} accessibilityRole="tablist">
      {LEVELS.map((l) => {
        const selected = value === l.key;
        const n = counts[l.key] ?? 0;
        return (
          <Pressable
            key={l.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={`${l.label}, ${n} card${n === 1 ? '' : 's'}`}
            onPress={() => onChange(l.key)}
            style={{
              flex: 1,
              minHeight: TOUCH_TARGET,
              alignItems: 'center',
              justifyContent: 'center',
              gap: space.hair,
              paddingVertical: space.sm,
              paddingHorizontal: space.xs,
              borderRadius: radius.button,
              borderWidth: 1,
              borderColor: selected ? t.accent : t.border,
              backgroundColor: selected ? t.accent : 'transparent',
            }}
          >
            <Text
              style={[type.label, { color: selected ? t.accentText : t.text }]}
              numberOfLines={1}
            >
              {l.label}
            </Text>
            {/* The count on its own line, so the label can wrap or truncate
                without taking the number with it. */}
            <Text style={[type.caption, { color: selected ? t.accentText : t.textMuted }]}>
              {n}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * What "there is nothing here" says, in one voice.
 *
 * The three study screens carried seven near-duplicate strings between them,
 * including three different phrasings of the same sentence about the retry
 * pile. Copy drifts exactly the way code does, and for the same reason.
 *
 * `subject` is the only thing that legitimately differs — cards, questions,
 * blanks — so it is the only thing a screen passes.
 */
export function emptyLevelCopy(subject: string, retryOnly: boolean): string {
  return retryOnly
    ? 'Nothing to retry here — you have not missed anything at this level yet.'
    : `No ${subject} at this level yet.`;
}
