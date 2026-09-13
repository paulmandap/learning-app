import { Text, View } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { PillButton } from './components';
import { NomiCharacter } from './nomi-character';
import { space, type, useTheme } from './theme';
import type { NomiState } from '../core/nomi-motion';

/**
 * The way in to Nomi from a screen's heading.
 *
 * ## Why the top of the screen and not the tab bar
 *
 * The four tabs are the learning loop — Study, Notes, Progress, Settings — and a
 * fifth for a companion would say Nomi is a place you go instead of studying.
 * It is the opposite: something that sits beside whatever you are already
 * looking at.
 *
 * ## Two surfaces, one companion, different jobs
 *
 * This pill and the floating ✦ both used to wear ✦, which made one companion's
 * two surfaces impossible to tell apart: nothing said that one opens a screen
 * and the other asks about the card in front of you (NOTES §35).
 *
 * Now they differ by ROLE and share an IDENTITY. The pill carries Nomi's face
 * and name, because it goes to Nomi's own screen. The ✦ stays on the floating
 * button, because it is an action — ask — and the owl appears inside the panel
 * it opens. Same owl in both places, so it is still plainly one companion.
 *
 * The owl here only blinks: at 26 points a bob is a third of a pixel, and it
 * stops altogether while the tab is not the one showing.
 */
export function NomiButton() {
  const router = useRouter();
  const focused = useIsFocused();

  return (
    <PillButton
      label="Nomi"
      accessibilityLabel="Open Nomi"
      onPress={() => router.push('/nomi')}
      leading={<NomiCharacter state="idle" size={26} active={focused} />}
    />
  );
}

/**
 * Nomi, large, with a name and one line — the top of Nomi's own screen.
 *
 * Lives here rather than in `app/nomi.tsx` so that screen stays built from
 * primitives with no inline styles, which it always has been.
 */
export function NomiHero({
  state,
  onDone,
  active,
}: {
  state: NomiState;
  onDone?: (finished: NomiState) => void;
  active?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.sm }}>
      <NomiCharacter
        state={state}
        size={132}
        onDone={onDone}
        active={active}
        accessibilityLabel="Nomi, a small brown owl"
      />
      <Text style={[type.display, { color: t.text }]}>Nomi</Text>
      <Text style={[type.body, { color: t.textMuted, textAlign: 'center' }]}>
        Your study companion. Ask it about the notes you are studying.
      </Text>
    </View>
  );
}
