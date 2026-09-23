import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { NomiCharacter } from './nomi-character';
import { SpeechBubble, useTypedLine } from './nomi';
import { space, useTheme } from './theme';
import { finishLine, finishReaction } from '../core/celebrate';
import { useLastRound } from '../data/last-round';

/**
 * Nomi's reaction when a flashcard deck, a quiz or a round of blanks ends
 * (NOTES §43): a hop with both wings out when it went well, nods and a pat of
 * the wing when it was rough.
 *
 * And what Nomi says about it (§45): in a speech bubble, thought about for a
 * moment and then typed, as on Home — words that follow how the round went,
 * several for each result, never the ones said at the end of the last round,
 * and cheering however low the score (`finishLine`).
 *
 * The ONLY surface allowed to ask for `success` or `encouraging` —
 * `tests/screens.test.ts` holds every other file to that — so Nomi reacts to a
 * finished round and never to a single answer, which is what the owner chose.
 * Nothing at all for a round with nothing answered. It records the round, so
 * Nomi on Home reacts the same way when the student goes back to it (§45).
 */
export function NomiFinish({ right, total }: { right: number; total: number }) {
  const t = useTheme();
  const reaction = finishReaction(right, total);
  // Picked once for this round, and never what Nomi said when the last one ended.
  const [line] = useState(() => finishLine(right, total, Math.random, useLastRound.getState().line));
  const finished = useLastRound((s) => s.finished);
  useEffect(() => {
    if (reaction && line) finished(reaction, line);
  }, [reaction, line, finished]);
  const typed = useTypedLine(line ?? '', !!line);
  if (!reaction || !line) return null;

  return (
    <View
      accessible
      accessibilityLabel={`${reaction === 'success' ? 'Nomi, celebrating' : 'Nomi, cheering you on'}: ${line}`}
      style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.md }}
    >
      {/* A perfect round earns the cap (NOTES §50); `success` brings its own sparkles. */}
      <NomiCharacter state={reaction} settle="idle" size={84} prop={total > 0 && right === total ? 'cap' : null} />
      <SpeechBubble line={line} saying={typed.saying} shown={typed.shown} chars={typed.chars} surface={t.bg} />
    </View>
  );
}
