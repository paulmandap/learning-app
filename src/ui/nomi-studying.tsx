import { View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { NomiCharacter } from './nomi-character';
import { ProgressBar } from './components';
import { space } from './theme';

/**
 * How far through the round you are, with Nomi reading beside it (NOTES §45).
 *
 * The owner: *"i still don't see the studying/focused animation."* It played
 * only in the ✦ panel over an open card, and nobody opens that while studying.
 * Asked where it should be, they chose beside the cards: Nomi small, eyes down
 * and moving along a line, next to the count on flashcards, the quiz and
 * fill-in-the-blanks. It does not react to answers — Nomi reacts when the round
 * ends (`NomiFinish`) — and it stops when the screen is not in front.
 */
export function StudyProgress({ value, total }: { value: number; total: number }) {
  const focused = useIsFocused();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <NomiCharacter state="studying" size={56} active={focused} />
      <View style={{ flex: 1 }}>
        <ProgressBar value={value} total={total} />
      </View>
    </View>
  );
}
