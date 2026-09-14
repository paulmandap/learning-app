import { Text, View } from 'react-native';
import { NomiCharacter } from './nomi-character';
import { space, type, useTheme } from './theme';
import { finishLine, finishReaction } from '../core/celebrate';

/**
 * Nomi's reaction when a flashcard deck, a quiz or a round of blanks ends
 * (NOTES §43): a hop with both wings out when it went well, nods and a pat of
 * the wing when it was rough, and one short line.
 *
 * The ONLY surface allowed to ask for `success` or `encouraging` —
 * `tests/screens.test.ts` holds every other file to that — so Nomi reacts to a
 * finished round and never to a single answer, which is what the owner chose.
 * Nothing at all for a round with nothing answered.
 */
export function NomiFinish({ right, total }: { right: number; total: number }) {
  const t = useTheme();
  const reaction = finishReaction(right, total);
  if (!reaction) return null;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <NomiCharacter
        state={reaction}
        settle="idle"
        size={84}
        accessibilityLabel={reaction === 'success' ? 'Nomi, celebrating' : 'Nomi, cheering you on'}
      />
      <Text style={[type.body, { color: t.text, flex: 1 }]}>{finishLine(reaction, right, total)}</Text>
    </View>
  );
}
