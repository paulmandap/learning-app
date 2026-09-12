import { useEffect, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { INPUT_FONT_SIZE, radius, space, useTheme } from './theme';
import { fetchProfile } from '../data/profile';
import { askAssistant } from '../data/assistant';
import { useAssistantContext } from '../data/assistant-context';
import { describeRemaining, isAskable, MAX_QUESTION_CHARS } from '../core/chat';

/**
 * The study assistant (Phase 9c, D14) — this is Nomi.
 *
 * ## The name
 *
 * Nomi is the product identity for this, not a second AI beside it. `Nomi` on a
 * screen and `StudyAssistant` in the code are the same thing: the name changed,
 * the architecture did not, and `askAssistant` remains the implementation.
 *
 * This floating button is Nomi in its IN-CONTEXT form — it sees the card in
 * front of you. `app/nomi.tsx` is the dedicated place, reached from the heading
 * of Study and Progress, for questions about the studying rather than about one
 * card. Neither is finished; both are the same companion.
 *
 * **The D13 privacy copy in `app/(tabs)/settings.tsx` deliberately still says
 * "the study assistant".** That paragraph is approved copy which D13 says must
 * not be paraphrased smaller, and the owner's instruction is to leave it alone.
 * So the app names Nomi everywhere except there — a chosen inconsistency, not a
 * missed rename, and `tests/screens.test.ts` pins the sentence so an edit
 * cannot drift into it.
 *
 * A small circle in the bottom corner that opens into a panel big enough to
 * read and type in — the owner's words. Closed it is one tappable circle;
 * open it is a sheet on a phone and a panel beside the content on a desktop.
 *
 * ## Deliberately not a chat app
 *
 * One question, one answer, no scrollback. That is not a shortcut:
 *
 *  - a conversation history would be sent with every follow-up, so the third
 *    question in a thread costs several times the first — on a free tier shared
 *    with the thing that actually makes the cards;
 *  - the answer is grounded in the card or the notes in front of you, and a
 *    thread drifts away from that grounding with each turn;
 *  - the useful question here is "explain this bit", asked and answered.
 *
 * ## What it knows
 *
 * Whatever the current screen put in `useAssistantContext` — the open card on a
 * study screen, the set's notes elsewhere. An ungrounded assistant would be
 * worse than the Gemini web app for the same quota, and could confidently
 * contradict the notes the student is about to be examined on.
 */

const CLOSED_SIZE = 52;
/** Wide enough for a paragraph without being a second window. */
const PANEL_WIDTH = 380;
/** Below this the panel goes nearly full width, as a sheet. */
const NARROW_MAX_WIDTH = 520;

/**
 * Height of the bottom tab bar, cleared so the button does not sit on it.
 *
 * The assistant is mounted once above the navigator, so it floats over screens
 * that have a tab bar and screens that do not. Without this it landed squarely
 * on top of the Settings tab — visible the moment the screen was screenshotted,
 * and invisible to typecheck and 398 tests.
 *
 * Matches app/(tabs)/_layout.tsx: space.xs of top padding plus a 44px minimum
 * touch target. The safe-area inset is added separately by both, so it is not
 * counted twice.
 */
const TAB_BAR_HEIGHT = space.xs + 44;

/** Sidebar layouts put navigation on the left, so nothing to clear at the bottom. */
const SIDEBAR_MIN_WIDTH = 800;

export function StudyAssistant() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const context = useAssistantContext((s) => s.context);

  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const apiKey = profile?.gemini_api_key ?? '';

  const narrow = width < NARROW_MAX_WIDTH;
  const panelWidth = narrow ? Math.min(width - space.lg * 2, 420) : PANEL_WIDTH;

  // Clear the tab bar, but only where there IS one: the tabs group draws it at
  // the bottom on a phone and down the left side on a desktop, and a study
  // screen pushed above the group has none at all. Offsetting unconditionally
  // would leave the button floating in mid-air on every deck.
  const segments = useSegments();
  const overTabs = segments[0] === '(tabs)' && width < SIDEBAR_MIN_WIDTH;
  // space.xl above the bar rather than space.lg. On the owner's iPhone the
  // button read as "sitting in the wrong part" — 16px above a bar that already
  // carries the home indicator under it left the two crowding each other, and a
  // floating control that nearly touches fixed furniture looks misplaced rather
  // than floating.
  const bottomOffset = insets.bottom + space.xl + (overTabs ? TAB_BAR_HEIGHT : 0);

  // Escape closes it, the way any overlay should on a keyboard.
  useEffect(() => {
    if (Platform.OS !== 'web' || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function ask() {
    // A ref, set synchronously. The same double-submit that produced phantom
    // quiz questions would here spend two of a capped twenty on one question.
    if (inFlight.current || !isAskable(question)) return;
    inFlight.current = true;
    setBusy(true);
    setAnswer(null);
    setNote(null);

    const result = await askAssistant({ question, context, apiKey });

    if (result.ok) {
      setAnswer(result.answer);
      setNote(describeRemaining(result.remaining));
    } else {
      setNote(result.message);
    }
    setBusy(false);
    inFlight.current = false;
  }

  // ------------------------------------------------------------- closed --
  if (!open) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ask Nomi about your notes"
        onPress={() => setOpen(true)}
        style={{
          position: 'absolute',
          right: space.lg,
          bottom: bottomOffset,
          // Explicit, so this does not depend on being a later sibling of
          // <Stack> than the navigator's own positioned containers.
          zIndex: 30,
          width: CLOSED_SIZE,
          height: CLOSED_SIZE,
          borderRadius: CLOSED_SIZE / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.accent,
          // A real shadow, because this floats over content rather than sitting
          // in it — without one it reads as a flat sticker on the page.
          shadowColor: '#000',
          shadowOpacity: 0.22,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 3 },
          elevation: 5,
        }}
      >
        <Text style={{ fontSize: 22, color: t.accentText }}>✦</Text>
      </Pressable>
    );
  }

  // --------------------------------------------------------------- open --
  //
  // A dimmed overlay, not a card sitting in the page. The owner, on an iPhone:
  // "when I click on chatbot it's kinda hard to focus, there's too much
  // distracting part" — the panel opened among the set rows and read as one
  // more thing on a busy screen rather than as the thing being used.
  //
  // On a phone it sits near the TOP, which looks like an odd place for a
  // bottom-corner button to open into until you watch it with the keyboard up:
  // iOS does not shrink the page for its keyboard, so anything anchored to the
  // bottom ends up behind it, and Safari then scrolls the whole app to chase
  // the field. The top half is the only part of the screen the keyboard cannot
  // take. On a desktop there is no keyboard to dodge, so it stays in the corner
  // it opened from.
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 30,
        alignItems: narrow ? 'center' : 'flex-end',
        justifyContent: narrow ? 'flex-start' : 'flex-end',
      }}
    >
      {/* Tapping away closes it — the gesture everyone tries first. It is a
          real control rather than a bare View so it reaches the keyboard and a
          screen reader too. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close Nomi"
        onPress={() => setOpen(false)}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          // 0.7, not the 0.55 this started at. Checked in dark, which is how
          // the owner actually uses it: black over a near-black page barely
          // separates the panel from what is behind it, and the whole point of
          // the scrim is that separation. Light mode carries 0.7 comfortably.
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
        }}
      />
      <View
        style={{
          width: panelWidth,
          marginTop: narrow ? insets.top + space.lg : 0,
          marginRight: narrow ? 0 : space.lg,
          marginBottom: narrow ? 0 : bottomOffset,
          // Tall enough to read a four-sentence answer without scrolling, and
          // never taller than the window it floats in.
          maxHeight: Math.min(height - insets.top - space.xl * 2, 460),
          backgroundColor: t.card,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: radius.lg,
          padding: space.lg,
          gap: space.sm,
          shadowColor: '#000',
          shadowOpacity: 0.24,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 6 },
          elevation: 8,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ flex: 1, fontSize: 16, fontWeight: '700', color: t.text }}>
            Ask Nomi
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => setOpen(false)}
            hitSlop={10}
          >
            <Text style={{ fontSize: 20, color: t.textMuted }}>✕</Text>
          </Pressable>
        </View>

        {/* Says what it can see, so the answers are not mysterious. A student who
            knows it is looking at this card asks better questions of it. */}
        <Text style={{ fontSize: 13, color: t.textMuted }}>
          {context.kind === 'card'
            ? 'Looking at the card in front of you.'
            : context.kind === 'set'
              ? `Looking at "${context.title}".`
              : 'Open a set and I can answer from your own notes.'}
        </Text>

        <TextInput
          value={question}
          onChangeText={setQuestion}
          placeholder="Why is this the answer?"
          placeholderTextColor={t.textMuted}
          multiline
          maxLength={MAX_QUESTION_CHARS}
          onSubmitEditing={ask}
          // The panel opens because someone wants to type. Landing in the field
          // saves a tap, and there is nothing else here to focus.
          autoFocus
          style={{
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: radius.sm,
            backgroundColor: t.bg,
            color: t.text,
            padding: space.md,
            minHeight: 64,
            // NOT 15. This field is where the owner found it: iOS zoomed the
            // whole app on focus and left it zoomed, and swiping around the
            // zoomed page showed blank canvas past the edges. See INPUT_FONT_SIZE.
            fontSize: INPUT_FONT_SIZE,
          }}
        />

        <Pressable
          accessibilityRole="button"
          onPress={ask}
          disabled={busy || !isAskable(question)}
          style={{
            backgroundColor: busy || !isAskable(question) ? t.border : t.accent,
            borderRadius: radius.sm,
            paddingVertical: space.md,
            alignItems: 'center',
            minHeight: 44,
            justifyContent: 'center',
          }}
        >
          <Text
            style={{
              color: busy || !isAskable(question) ? t.textMuted : t.accentText,
              fontWeight: '700',
              fontSize: 15,
            }}
          >
            {busy ? 'Thinking…' : 'Ask'}
          </Text>
        </Pressable>

        {answer ? (
          // Scrolls rather than clipping: four sentences fit, and an occasional
          // longer answer must still be readable to the end.
          <ScrollView style={{ flexShrink: 1 }}>
            <Text style={{ color: t.text, fontSize: 15, lineHeight: 22 }}>{answer}</Text>
          </ScrollView>
        ) : null}

        {note ? <Text style={{ color: t.textMuted, fontSize: 13 }}>{note}</Text> : null}
      </View>
    </View>
  );
}
