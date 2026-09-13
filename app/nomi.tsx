import { useCallback, useRef, useState } from 'react';
import { Stack, useIsFocused, useNavigation, useRouter } from 'expo-router';
import { Body, Button, Card, Label, Screen } from '../src/ui/components';
import { HeaderBackButton } from '../src/ui/menu';
import { GLYPH } from '../src/ui/glyphs';
import { NomiHero } from '../src/ui/nomi';
import { DAILY_MESSAGE_LIMIT } from '../src/core/chat';
import type { NomiState } from '../src/core/nomi-motion';

/**
 * Nomi — the companion's own screen.
 *
 * ## Written for what Nomi is today
 *
 * This was a roadmap in the future tense — "Nomi will become…", "Soon Nomi
 * will also know…" — with three named empty slots and nothing to do. Some of
 * what it promised had already shipped, and a screen that describes a product
 * that does not exist yet reads, to the student holding it, as a product that
 * does not work (NOTES §35).
 *
 * So it says what is true now, in the present tense: how to ask, what Nomi
 * reads, and what it does not do. The capability is unchanged — one question,
 * one answer, grounded in the card or the set's notes (D14). The fix for an
 * empty-looking screen was honesty about the present, not new intelligence.
 *
 * ## Why there is still no conversation here
 *
 * **D14 gives the assistant one question and one answer with no history**,
 * because a conversation re-sends its whole thread on every turn and the
 * allowance it spends is the same one that makes the cards. And answering
 * "what should I study today?" honestly needs learning data this screen does
 * not read — a companion that makes up how you are doing is worse than one
 * that says nothing, because it gets believed.
 *
 * ## No queries
 *
 * Opening this screen asks the database for nothing. `getNomiContext` in
 * `src/data/nomi.ts` is the boundary it will read through, and it stays unused
 * until there is something true to show.
 *
 * ## Hello and goodbye
 *
 * Nomi greets on arrival and waves on the way out. The wave is awaited by the
 * back control, so it is kept to half a second and never allowed to hold the
 * way out hostage: a timer leaves anyway if the animation cannot report back.
 */
export default function Nomi() {
  const router = useRouter();
  const navigation = useNavigation();
  const focused = useIsFocused();
  const [state, setState] = useState<NomiState>('greeting');

  const leaving = useRef<Promise<void> | null>(null);
  const waved = useRef<(() => void) | null>(null);

  /** Wave, then resolve — on the animation finishing, or on the timer, whichever is first. */
  const sayGoodbye = useCallback(() => {
    if (!leaving.current) {
      leaving.current = new Promise<void>((resolve) => {
        waved.current = resolve;
        setState('goodbye');
        setTimeout(resolve, GOODBYE_CEILING_MS);
      });
    }
    return leaving.current;
  }, []);

  const leave = useCallback(async () => {
    await sayGoodbye();
    if (navigation.canGoBack()) router.back();
    else router.replace('/');
  }, [navigation, router, sayGoodbye]);

  return (
    <Screen>
      {/* The layout registers this route with `backable`; this replaces only the
          control, so the back chevron waits for the wave. The stack header
          still names the screen, so there is no body heading to repeat it. */}
      <Stack.Screen options={{ headerLeft: () => <HeaderBackButton onBeforeLeave={sayGoodbye} /> }} />

      <NomiHero
        state={state}
        active={focused}
        onDone={(finished) => {
          if (finished === 'goodbye') waved.current?.();
        }}
      />

      <Card>
        <Label>Ask about what you are studying</Label>
        <Body>
          Open a set, or start a deck, and tap {GLYPH.nomi} in the corner. Ask why an answer is
          right, or what a line in your notes means.
        </Body>
        <Body muted>One question at a time, up to {DAILY_MESSAGE_LIMIT} a day.</Body>
      </Card>

      <Card>
        <Label>What Nomi reads</Label>
        <Body>
          The card in front of you, or the notes of the set you have open — nothing else.
        </Body>
        <Body muted>
          It answers from those notes first. When they do not cover something, it says so before
          answering anyway. Like making cards, asking sends your question and those notes to Google;
          Settings explains what that means.
        </Body>
      </Card>

      <Card>
        <Label>What Nomi does not do</Label>
        <Body muted>
          It does not remember your earlier questions, and it cannot see how you have been doing.
          Progress shows that.
        </Body>
      </Card>

      <Button label="Back to studying" variant="outline" onPress={() => void leave()} />
    </Screen>
  );
}

/**
 * The longest leaving will ever wait. The wave itself is 520ms; this is the
 * backstop for when it cannot say it finished.
 */
const GOODBYE_CEILING_MS = 800;
