import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { radius, space, TOUCH_TARGET, type, useTheme } from './theme';

/**
 * The way in to Nomi from a screen's heading.
 *
 * ## Why the top of the screen and not the tab bar
 *
 * The four tabs are the learning loop — Study, Notes, Progress, Settings — and a
 * fifth for a companion would say Nomi is a place you go instead of studying.
 * It is the opposite: something that sits beside whatever you are already
 * looking at. The bottom-right corner is also already taken by the floating ✦,
 * which is Nomi in its in-context form (ask about the card in front of you).
 *
 * ## The same ✦, deliberately
 *
 * The floating button has always drawn ✦ (see `assistant.tsx`). Giving this a
 * different mark would make one companion look like two features. Same glyph,
 * same thing, now with a name on it.
 *
 * Kept plain on purpose: this is a working entry point, not a finished design,
 * and it is expected to be restyled once the visual treatment is decided.
 */
export function NomiButton() {
  const router = useRouter();
  const t = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open Nomi"
      onPress={() => router.push('/nomi')}
      hitSlop={8}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        minHeight: TOUCH_TARGET,
        paddingHorizontal: space.md,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.card,
      }}
    >
      <Text style={{ fontSize: 15, color: t.accent }}>✦</Text>
      <Text style={[type.label, { color: t.text }]}>Nomi</Text>
    </Pressable>
  );
}

/**
 * A labelled area of the Nomi screen that has nothing in it yet.
 *
 * Nomi's screen is a set of boundaries waiting to be filled, and an empty one
 * has to read as "not built yet" rather than as "broken" or, worse, as a
 * feature that silently does nothing. Naming each one keeps the screen honest
 * about what it is: a place held open.
 */
export function NomiSlot({ heading, children }: { heading: string; children: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <Text style={[type.label, { color: t.textMuted }]}>{heading}</Text>
      <Text style={[type.body, { color: t.textMuted }]}>{children}</Text>
    </View>
  );
}
