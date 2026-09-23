import { useEffect, useRef, useState } from 'react';
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
 * fill-in-the-blanks. It stops when the screen is not in front.
 *
 * And it nods at each right answer (NOTES §49): two small bobs with its eyes
 * closed happy, then back to reading. The owner chose that over §43's "never
 * after a single answer" — which still holds for the celebration proper:
 * `success` and `encouraging` are the round's end, and only `NomiFinish` asks
 * for them. `right` only has to go up; a round starting again leaves it be.
 */
export function StudyProgress({ value, total, right = 0 }: { value: number; total: number; right?: number }) {
  const focused = useIsFocused();
  const [nodding, setNodding] = useState(false);
  const last = useRef(right);
  useEffect(() => {
    if (right > last.current) setNodding(true);
    last.current = right;
  }, [right]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <NomiCharacter
        state={nodding ? 'nod' : 'studying'}
        settle="studying"
        // Reading its book, as the reference sheet's studying Nomi does (§50).
        prop="book"
        size={56}
        active={focused}
        onDone={(done) => {
          if (done === 'nod') setNodding(false);
        }}
      />
      <View style={{ flex: 1 }}>
        <ProgressBar value={value} total={total} />
      </View>
    </View>
  );
}
