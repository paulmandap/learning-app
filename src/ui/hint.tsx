import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { radius, space, type, useTheme } from './theme';
import { HINT_AFTER_MS } from '../core/hints';
import { askForHint } from '../data/hints';

/**
 * "Want a hint?" beside the count, after twenty seconds on one card (NOTES §69).
 *
 * The owner's choices: Nomi asks, and nothing shows until it is tapped — a
 * hint that appeared by itself would spoil a card the student was about to
 * get. The tap shows the quick clue (`src/core/hints.ts`), instant and free,
 * and says so to the screen (`onShown`), which then records the answer as
 * hinted — right still counts as right, and the card comes back sooner. Under
 * the clue, "Ask Nomi for a bigger hint" asks Gemini (`askForHint`), when there
 * is a key to ask with.
 */

export interface HintSpec {
  /** Changes with every card, so a new card starts the wait again. */
  key: string;
  /** False once the card is turned over or answered: nothing to hint at then. */
  active: boolean;
  /** What a tap shows first. Null: no clue for this card, only the bigger hint. */
  clue: string | null;
  /** What a bigger hint is about. Null where only the clue makes sense. */
  bigger: { question: string; answer: string; source: string } | null;
  apiKey: string;
  /** The student saw a hint for this card. */
  onShown: () => void;
}

/** True once `ms` have passed on this `key` while `active`. */
export function useStuck(key: string, active: boolean, ms = HINT_AFTER_MS): boolean {
  const [stuckOn, setStuckOn] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setStuckOn(key), ms);
    return () => clearTimeout(timer);
  }, [key, active, ms]);
  return active && stuckOn === key;
}

type Bigger = { state: 'idle' } | { state: 'asking' } | { state: 'done'; text: string; note: string | null } | { state: 'failed'; text: string };

/** The offer, then the clue, then the bigger hint. Keyed by the card by its caller. */
export function HintOffer({ spec, onOffered }: { spec: HintSpec; onOffered: () => void }) {
  const t = useTheme();
  const stuck = useStuck(spec.key, spec.active);
  const [open, setOpen] = useState(false);
  const [bigger, setBigger] = useState<Bigger>({ state: 'idle' });

  useEffect(() => {
    if (stuck) onOffered();
    // Once per card: `onOffered` is a new function every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stuck]);

  if (!spec.active || (!stuck && !open)) return null;

  const show = () => {
    setOpen(true);
    spec.onShown();
  };
  const askBigger = async () => {
    if (!spec.bigger) return;
    setBigger({ state: 'asking' });
    const reply = await askForHint({ ...spec.bigger, apiKey: spec.apiKey });
    setBigger(reply.ok ? { state: 'done', text: reply.hint, note: reply.note } : { state: 'failed', text: reply.message });
  };

  const bubble = {
    alignSelf: 'flex-start' as const,
    maxWidth: '100%' as const,
    marginLeft: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    borderTopLeftRadius: space.xs,
    borderWidth: 1,
    borderColor: t.accent,
    backgroundColor: t.card,
    gap: space.xs,
  };

  if (!open) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Nomi: want a hint? Show a hint"
        accessibilityLiveRegion="polite"
        onPress={show}
        style={({ pressed }) => [bubble, { opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={[type.bodyStrong, { color: t.text }]}>Want a hint?</Text>
        <Text style={[type.caption, { color: t.accent }]}>Tap for a clue</Text>
      </Pressable>
    );
  }

  return (
    <View style={bubble} accessibilityLiveRegion="polite">
      <Text style={[type.caption, { color: t.accent, fontWeight: '700' }]}>Hint</Text>
      {spec.clue ? <Text style={[type.body, { color: t.text }]}>{spec.clue}</Text> : null}
      {bigger.state === 'done' || bigger.state === 'failed' ? (
        <Text style={[type.body, { color: bigger.state === 'done' ? t.text : t.textMuted }]}>{bigger.text}</Text>
      ) : null}
      {bigger.state === 'done' && bigger.note ? (
        <Text style={[type.caption, { color: t.textMuted }]}>{bigger.note}</Text>
      ) : null}
      {spec.bigger && (bigger.state === 'idle' || bigger.state === 'asking') ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ask Nomi for a bigger hint"
          accessibilityState={{ busy: bigger.state === 'asking' }}
          disabled={bigger.state === 'asking'}
          onPress={() => void askBigger()}
          hitSlop={8}
          style={({ pressed }) => ({ minHeight: 32, justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
        >
          <Text style={[type.label, { color: bigger.state === 'asking' ? t.textMuted : t.accent, fontWeight: '600' }]}>
            {bigger.state === 'asking' ? 'Nomi is thinking…' : spec.clue ? 'Ask Nomi for a bigger hint' : 'Ask Nomi for a hint'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
