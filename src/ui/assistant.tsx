import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { elevation, radius, space, TAB_BAR_HEIGHT, type, useTheme } from './theme';
import { useAssistantContext } from '../data/assistant-context';
import { useNomiConversation } from '../data/nomi-session';
import type { NomiState } from '../core/nomi-motion';
import { NomiCharacter } from './nomi-character';
import { ChatBubble, Composer } from './nomi';
import { GLYPH } from './glyphs';

/**
 * Nomi, in context — the floating ✦ (Phase 9c; a chat since NOTES §36).
 *
 * ## The name
 *
 * Nomi is the product identity for this, not a second AI beside it. The ✦ and
 * Nomi's own screen are two windows onto ONE conversation: a question asked
 * here about a card carries on in the full chat, and the other way round,
 * because both read the same `useNomiConversation`.
 *
 * **The D13 privacy copy in `app/(tabs)/settings.tsx` deliberately still says
 * "the study assistant".** That paragraph is approved copy which D13 says must
 * not be paraphrased smaller, and the owner's instruction is to leave the name
 * out of it. It was EXTENDED with his approval when Nomi learned about the
 * student (§36) — the wording changed, the name rule did not.
 *
 * ## What it knows
 *
 * Whatever the current screen put in `useAssistantContext` — the open card on a
 * study screen, the set's notes elsewhere — plus everything Nomi knows about the
 * student from the app. Grounded answers still come from the notes first.
 *
 * ## No longer one question and one answer
 *
 * D14 kept this to a single exchange with no history. The owner reversed that
 * (§36), and the costs D14 named are handled rather than ignored: only the
 * last twenty messages go with each new one, Nomi's own brain answers app
 * questions without a model call, and the daily cap still applies to the rest.
 */

const CLOSED_SIZE = 52;
/** Wide enough for a paragraph without being a second window. */
const PANEL_WIDTH = 380;
/** Below this the panel goes nearly full width, as a sheet. */
const NARROW_MAX_WIDTH = 520;
/** Sidebar layouts put navigation on the left, so nothing to clear at the bottom. */
const SIDEBAR_MIN_WIDTH = 800;
/** The panel shows the tail of the conversation; the full chat has the rest. */
const PANEL_TURNS = 6;

export function StudyAssistant() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const context = useAssistantContext((s) => s.context);
  const chat = useNomiConversation(context);

  const [open, setOpen] = useState(false);
  const scroll = useRef<ScrollView>(null);

  const narrow = width < NARROW_MAX_WIDTH;
  const panelWidth = narrow ? Math.min(width - space.lg * 2, 420) : PANEL_WIDTH;

  // Clear the tab bar, but only where there IS one: the tabs group draws it at
  // the bottom on a phone and down the left side on a desktop, and a study
  // screen pushed above the group has none at all.
  const segments = useSegments();
  const overTabs = segments[0] === '(tabs)' && width < SIDEBAR_MIN_WIDTH;
  // space.xl above the bar rather than space.lg: on the owner's iPhone the
  // button read as crowding the home indicator at 16px.
  // TAB_BAR_HEIGHT comes from theme.ts, where the tab bar's height is decided.
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
          zIndex: elevation.float,
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
        <Text style={{ fontSize: 22, color: t.accentText }}>{GLYPH.nomi}</Text>
      </Pressable>
    );
  }

  // --------------------------------------------------------------- open --
  //
  // Nomi, in the panel's heading, doing what the panel is doing: a hello as it
  // opens, thinking while the answer is on its way, a small "here it is" when
  // it lands. On a card it settles into reading rather than idling. Pure
  // presentation — nothing about what is asked, sent or shown depends on it.
  const rest: NomiState = context.kind === 'card' ? 'studying' : 'idle';
  const lastTurn = chat.turns.at(-1);
  const nomiState: NomiState = chat.busy ? 'thinking' : lastTurn?.role === 'nomi' ? 'explaining' : 'greeting';
  const recent = chat.turns.slice(-PANEL_TURNS);

  // A dimmed overlay, not a card sitting in the page. The owner, on an iPhone:
  // "when I click on chatbot it's kinda hard to focus, there's too much
  // distracting part".
  //
  // On a phone it sits near the TOP: iOS does not shrink the page for its
  // keyboard, so anything anchored to the bottom ends up behind it, and Safari
  // then scrolls the whole app to chase the field. On a desktop there is no
  // keyboard to dodge, so it stays in the corner it opened from.
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: elevation.float,
        alignItems: narrow ? 'center' : 'flex-end',
        justifyContent: narrow ? 'flex-start' : 'flex-end',
      }}
    >
      {/* Tapping away closes it — the gesture everyone tries first. */}
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
          // 0.7, not 0.55: checked in dark, which is how the owner uses it.
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
        }}
      />
      <View
        style={{
          width: panelWidth,
          marginTop: narrow ? insets.top + space.lg : 0,
          marginRight: narrow ? 0 : space.lg,
          marginBottom: narrow ? 0 : bottomOffset,
          maxHeight: Math.min(height - insets.top - space.xl * 2, 560),
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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <NomiCharacter state={nomiState} settle={rest} size={40} />
          <Text style={[type.button, { flex: 1, color: t.text }]}>Ask Nomi</Text>
          {/* The same conversation, with room to read it. */}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setOpen(false);
              router.push('/nomi');
            }}
            hitSlop={8}
          >
            <Text style={[type.label, { color: t.accent }]}>Open chat</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setOpen(false)} hitSlop={10}>
            <Text style={{ fontSize: 20, color: t.textMuted }}>{GLYPH.close}</Text>
          </Pressable>
        </View>

        {/* Says what it can see, so the answers are not mysterious. */}
        <Text style={[type.label, { color: t.textMuted }]}>
          {context.kind === 'card'
            ? 'Looking at the card in front of you.'
            : context.kind === 'set'
              ? `Looking at "${context.title}".`
              : 'Ask me anything, or open a set and I can answer from your notes.'}
        </Text>

        {recent.length > 0 ? (
          <ScrollView
            ref={scroll}
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ gap: space.sm }}
            onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
          >
            {recent.map((turn, i) => (
              <ChatBubble key={i} turn={turn} showOwl={false} />
            ))}
          </ScrollView>
        ) : null}

        {chat.busy ? <Text style={[type.label, { color: t.textMuted }]}>Nomi is thinking…</Text> : null}
        {chat.note ? <Text style={[type.label, { color: t.textMuted }]}>{chat.note}</Text> : null}

        <Composer
          busy={chat.busy}
          placeholder={context.kind === 'card' ? 'Why is this the answer?' : 'Message Nomi'}
          // The panel opens because someone wants to type.
          autoFocus
          onSend={(text) => void chat.send(text)}
        />
      </View>
    </View>
  );
}
