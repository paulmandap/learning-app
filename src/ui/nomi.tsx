import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { NomiCharacter } from './nomi-character';
import { GLYPH } from './glyphs';
import { useReducedMotion } from './motion';
import { INPUT_FONT_SIZE, radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import { Button } from './components';
import { isSendable, MAX_PASTE_CHARS, type ChatTurn } from '../core/chat';
import { actionCard, CARD_COUNTS, type NomiAction } from '../core/nomi-actions';
import { revealedCount, revealSchedule, THINK_MS } from '../core/typing';
import { nextGreetingDelay, type NomiState } from '../core/nomi-motion';
import { returnReaction } from '../core/celebrate';
import { useLastRound } from '../data/last-round';

const NATIVE = Platform.OS !== 'web';

/**
 * Nomi's presence in the app: Nomi on Home, and the pieces of a chat.
 *
 * ## Nomi on Home, twice redesigned by the owner
 *
 * First (NOTES §36), on a pill with the owl's face: *"I don't like how Nomi is
 * just looking like a button that needs to be clicked."* Nomi moved onto a card.
 *
 * Then (§37), pointing at another app's companion: *"when Tarsi is saying
 * something, it's on a text chat"* — the line sits in a speech bubble beside the
 * character — and of Nomi's line, *"it is static, it's not changing … like Nomi
 * is thinking for about 1 second and it will say that with the animation like it
 * is typing, letter by letter."*
 *
 * So Nomi stands beside a bubble with a tail pointing at it. Each time Home
 * comes into view, and each time the line changes, Nomi thinks — three dots,
 * the owl in its thinking pose — then types the line (`src/core/typing.ts`).
 * With reduce motion on, the line is simply there. Tapping opens the chat.
 *
 * ## Idle, a wave now and then, and the round just finished (NOTES §45)
 *
 * *"make nomi idle, and doing greeting from time-to-time"*, and *"if i recently
 * finished a flashcard, when i get back to nomi tab, nomi will do success
 * animation"* — matching how the round went, the owner chose. Both are a
 * one-shot played over the resting pose (`gesture`): the reaction first, on
 * coming back to Home after a round (`returnReaction`), and once the line has
 * been said, a wave at `nextGreetingDelay`.
 */
type Saying = 'thinking' | 'typing' | 'said';

export function NomiCard({ line, onPress }: { line: string; onPress: () => void }) {
  const t = useTheme();
  const focused = useIsFocused();
  const reduce = useReducedMotion();
  const chars = useMemo(() => Array.from(line), [line]);
  const schedule = useMemo(() => revealSchedule(line), [line]);
  const [saying, setSaying] = useState<Saying>('thinking');
  const [shown, setShown] = useState(0);

  useEffect(() => {
    // Nothing starts until the motion setting is known, and nothing runs while
    // Home is not the screen in front. Coming back to it says the line again.
    if (!focused || reduce === null) return;
    if (reduce) {
      setSaying('said');
      setShown(chars.length);
      return;
    }
    setSaying('thinking');
    setShown(0);
    let tick: ReturnType<typeof setInterval> | undefined;
    const think = setTimeout(() => {
      setSaying('typing');
      const start = Date.now();
      tick = setInterval(() => {
        const n = revealedCount(schedule, Date.now() - start);
        setShown(n);
        if (n >= chars.length && tick) {
          clearInterval(tick);
          setSaying('said');
        }
      }, 32);
    }, THINK_MS);
    return () => {
      clearTimeout(think);
      if (tick) clearInterval(tick);
    };
  }, [line, focused, reduce, schedule, chars.length]);

  // A one-shot over the resting pose: the reaction to a round, or a wave.
  const [gesture, setGesture] = useState<NomiState | null>(null);
  const waves = useRef(0);

  // Coming back to Home: react to a round that ended recently, once.
  useEffect(() => {
    waves.current = 0;
    if (!focused) {
      setGesture(null);
      return;
    }
    if (reduce === null) return;
    const { round, reactedAt, reacted } = useLastRound.getState();
    const reaction = returnReaction(round, reactedAt, Date.now());
    if (!reaction) return;
    reacted();
    if (!reduce) setGesture(reaction);
  }, [focused, reduce]);

  // Idle once the line is said, with a wave now and then.
  useEffect(() => {
    if (!focused || reduce !== false || saying !== 'said' || gesture !== null) return;
    const wave = setTimeout(() => {
      waves.current += 1;
      setGesture('greeting');
    }, nextGreetingDelay(waves.current === 0, Math.random));
    return () => clearTimeout(wave);
  }, [focused, reduce, saying, gesture]);

  const owl: NomiState =
    gesture ?? (saying === 'thinking' ? 'thinking' : saying === 'typing' ? 'explaining' : 'idle');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Talk to Nomi. ${line}`}
      onPress={onPress}
      style={({ pressed }) => ({ marginTop: space.sm, opacity: pressed ? 0.85 : 1 })}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: space.md,
          borderRadius: radius.lg,
          backgroundColor: t.infoBg,
          paddingHorizontal: space.md,
          paddingTop: space.md,
        }}
      >
        <View style={{ width: 84, alignItems: 'center' }}>
          <NomiCharacter
            state={owl}
            settle="idle"
            size={92}
            active={focused}
            // A finished gesture hands back to thinking, typing or idle.
            onDone={(done) => setGesture((current) => (current === done ? null : current))}
          />
        </View>

        <View style={{ flex: 1, marginBottom: space.lg }}>
          {/* The tail, pointing at Nomi. A square turned 45° with two edges
              drawn; the bubble covers its other half. */}
          <View
            style={{
              position: 'absolute',
              left: -6,
              bottom: 22,
              width: 14,
              height: 14,
              backgroundColor: t.card,
              borderLeftWidth: 1,
              borderBottomWidth: 1,
              borderColor: t.border,
              transform: [{ rotate: '45deg' }],
            }}
          />
          <View
            style={{
              backgroundColor: t.card,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: t.border,
              paddingVertical: space.md,
              paddingHorizontal: space.lg,
              gap: space.hair,
            }}
          >
            <Text style={[type.bodyStrong, { color: t.accent }]}>Nomi</Text>
            <View>
              {/* The whole line, invisible, holds the bubble at its finished
                  size — so it does not grow a line at a time while Nomi types. */}
              <Text style={[type.body, { color: t.text, opacity: 0 }]}>{line}</Text>
              <View style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
                {saying === 'thinking' ? (
                  <ThinkingDots />
                ) : (
                  <Text style={[type.body, { color: t.text }]}>{chars.slice(0, shown).join('')}</Text>
                )}
              </View>
            </View>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Three dots rising in turn — Nomi thinking before it speaks.
 *
 * Opacity only, native-driven where there is a native driver. Still under
 * reduced motion, where three dots still read as "one moment".
 */
export function ThinkingDots() {
  const t = useTheme();
  const reduce = useReducedMotion();
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0.35))).current;

  useEffect(() => {
    if (reduce !== false) return;
    const loops = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: NATIVE }),
          Animated.timing(dot, { toValue: 0.35, duration: 300, useNativeDriver: NATIVE }),
          Animated.delay((2 - i) * 150),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [reduce, dots]);

  return (
    <View
      accessibilityLabel="Nomi is thinking"
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, height: type.body.lineHeight }}
    >
      {dots.map((dot, i) => (
        <Animated.View
          key={i}
          style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.textMuted, opacity: dot }}
        />
      ))}
    </View>
  );
}

/** A message, the messenger way: the student's on the right, Nomi's on the left. */
export function ChatBubble({ turn, showOwl }: { turn: ChatTurn; showOwl: boolean }) {
  const t = useTheme();
  const mine = turn.role === 'user';

  return (
    <View style={{ flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: space.sm }}>
      {mine ? null : (
        // The owl beside the LAST of a run of Nomi's messages, as a messenger
        // shows a face once per group. Still (active false): a column of
        // bobbing owls down a long chat would be a column of distractions.
        <View style={{ width: 30, alignItems: 'center' }}>
          {showOwl ? <NomiCharacter state="idle" size={36} active={false} /> : null}
        </View>
      )}
      <View
        style={{
          maxWidth: '82%',
          paddingVertical: space.sm,
          paddingHorizontal: space.md,
          borderRadius: radius.lg,
          borderBottomRightRadius: mine ? space.xs : radius.lg,
          borderBottomLeftRadius: mine ? radius.lg : space.xs,
          backgroundColor: mine ? t.accent : t.card,
          borderWidth: mine ? 0 : 1,
          borderColor: t.border,
        }}
      >
        <Text selectable style={[type.body, { color: mine ? t.accentText : t.text }]}>
          {turn.text}
        </Text>
      </View>
    </View>
  );
}

/** Nomi, visibly thinking, while a reply is on its way. */
export function ThinkingBubble() {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
      <View style={{ width: 30, alignItems: 'center' }}>
        <NomiCharacter state="thinking" size={36} />
      </View>
      <View
        style={{
          paddingVertical: space.sm,
          paddingHorizontal: space.md,
          borderRadius: radius.lg,
          borderBottomLeftRadius: space.xs,
          backgroundColor: t.card,
          borderWidth: 1,
          borderColor: t.border,
        }}
      >
        <ThinkingDots />
      </View>
    </View>
  );
}

/**
 * Where the student types. Enter sends on a keyboard; Shift+Enter is a new line.
 *
 * `INPUT_FONT_SIZE`, never less — iOS zooms the whole app on a smaller field
 * and does not zoom back.
 */
export function Composer({
  onSend,
  busy,
  placeholder = 'Message Nomi',
  autoFocus,
}: {
  onSend: (text: string) => void;
  busy: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const t = useTheme();
  const [draft, setDraft] = useState('');
  // Up to a page of pasted notes: Nomi can make a set from them (NOTES §37).
  const canSend = !busy && isSendable(draft);

  const submit = () => {
    if (!canSend) return;
    const text = draft;
    setDraft('');
    onSend(text);
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder={placeholder}
        placeholderTextColor={t.textMuted}
        multiline
        // One line to start, growing as they type. Without it the web renders
        // a two-row box, which read as a form field rather than a chat input.
        numberOfLines={1}
        maxLength={MAX_PASTE_CHARS}
        autoFocus={autoFocus}
        onKeyPress={(e) => {
          const key = e.nativeEvent as { key: string; shiftKey?: boolean };
          if (Platform.OS === 'web' && key.key === 'Enter' && !key.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        style={{
          flex: 1,
          minHeight: TOUCH_TARGET,
          maxHeight: 140,
          borderWidth: 1,
          borderColor: t.border,
          borderRadius: radius.lg,
          backgroundColor: t.card,
          color: t.text,
          paddingHorizontal: space.md,
          paddingVertical: space.md,
          fontSize: INPUT_FONT_SIZE,
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send"
        onPress={submit}
        disabled={!canSend}
        style={{
          width: TOUCH_TARGET,
          height: TOUCH_TARGET,
          borderRadius: TOUCH_TARGET / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: canSend ? t.accent : t.border,
        }}
      >
        <Text style={{ color: canSend ? t.accentText : t.textMuted, fontSize: 20, fontWeight: '700' }}>
          {GLYPH.send}
        </Text>
      </Pressable>
    </View>
  );
}

/** A few things to say, for a conversation with nothing in it yet. */
export function Suggestions({ items, onPick }: { items: string[]; onPick: (text: string) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.sm }}>
      {items.map((item) => (
        <Pressable
          key={item}
          accessibilityRole="button"
          onPress={() => onPick(item)}
          style={({ pressed }) => ({
            minHeight: TOUCH_TARGET,
            justifyContent: 'center',
            paddingHorizontal: space.md,
            borderRadius: radius.pill,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: pressed ? t.bg : t.card,
          })}
        >
          <Text style={[type.label, { color: t.text }]}>{item}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Something Nomi offers to do, and the one tap that does it (NOTES §37).
 *
 * The owner chose to confirm first: nothing Nomi proposes is written until this
 * button is pressed, so pasting notes only to ask about them never makes a set
 * by accident. Sits in Nomi's column, under the question it asked. When the
 * offer is a set, the count Nomi picked is shown as a choice — tap another
 * before confirming.
 */
export function ActionCard({
  action,
  busy,
  onConfirm,
  onDismiss,
  onCount,
}: {
  action: NomiAction;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
  onCount: (count: number) => void;
}) {
  const t = useTheme();
  const card = actionCard(action);
  const counted = action.kind === 'make_set' || action.kind === 'add_notes' || action.kind === 'write_reviewer';

  return (
    <View style={{ flexDirection: 'row', gap: space.sm }}>
      <View style={{ width: 30 }} />
      <View
        style={{
          flex: 1,
          maxWidth: 420,
          gap: space.sm,
          padding: space.md,
          borderRadius: radius.lg,
          borderBottomLeftRadius: space.xs,
          borderWidth: 1,
          borderColor: t.accent,
          backgroundColor: t.card,
        }}
      >
        <Text style={[type.label, { color: t.textMuted }]}>{card.heading}</Text>
        <Text style={[type.bodyStrong, { color: t.text }]}>{card.detail}</Text>

        {counted ? (
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
            {CARD_COUNTS.map((count) => {
              const chosen = count === action.count;
              return (
                <Pressable
                  key={count}
                  accessibilityRole="radio"
                  accessibilityLabel={`${count} cards`}
                  accessibilityState={{ selected: chosen, disabled: busy }}
                  disabled={busy}
                  onPress={() => onCount(count)}
                  style={{
                    minWidth: TOUCH_TARGET,
                    minHeight: TOUCH_TARGET,
                    paddingHorizontal: space.md,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: radius.pill,
                    borderWidth: 1,
                    borderColor: chosen ? t.accent : t.border,
                    backgroundColor: chosen ? t.accent : 'transparent',
                  }}
                >
                  <Text style={[type.label, { color: chosen ? t.accentText : t.text }]}>{count}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button label={card.confirm} onPress={onConfirm} busy={busy} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Not now" variant="secondary" onPress={onDismiss} disabled={busy} />
          </View>
        </View>
      </View>
    </View>
  );
}

/** The start of a new conversation: Nomi saying hello, and something to say back. */
export function NomiWelcome({
  name,
  line,
  suggestions,
  onPick,
}: {
  name: string | null;
  line: string;
  suggestions: string[];
  onPick: (text: string) => void;
}) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.lg }}>
      <NomiCharacter state="greeting" size={112} accessibilityLabel="Nomi, a small brown owl" />
      <Text style={[type.title, { color: t.text, textAlign: 'center' }]}>
        {name ? `Hi ${name}! I'm Nomi.` : "Hi! I'm Nomi."}
      </Text>
      <Text style={[type.body, { color: t.textMuted, textAlign: 'center' }]}>{line}</Text>
      <Suggestions items={suggestions} onPick={onPick} />
    </View>
  );
}
