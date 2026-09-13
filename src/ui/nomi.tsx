import { useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { NomiCharacter } from './nomi-character';
import { GLYPH } from './glyphs';
import { INPUT_FONT_SIZE, radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import { isAskable, MAX_QUESTION_CHARS, type ChatTurn } from '../core/chat';

/**
 * Nomi's presence in the app: the card on Home, and the pieces of a chat.
 *
 * ## Why Nomi is no longer a button in the heading
 *
 * The owner, on the pill with the owl's face: *"I don't like how Nomi is just
 * looking like a button that needs to be clicked"* — with a screenshot of
 * another app's companion standing on the edge of a card beside a line it was
 * saying (NOTES §36). A companion that is part of the page reads as someone
 * there with you; one inside a bordered pill reads as a feature to find.
 *
 * So Nomi stands on a card on Home and says one true thing — the most useful
 * thing it knows right now, from `homeLine`. Tapping anywhere on it opens the
 * chat. The ✦ over a deck stays, because asking about the card in front of you
 * is an action, and an action is allowed to look like one.
 */
export function NomiCard({ line, onPress }: { line: string; onPress: () => void }) {
  const t = useTheme();
  const focused = useIsFocused();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Talk to Nomi. ${line}`}
      onPress={onPress}
      style={({ pressed }) => ({ marginTop: space.lg, opacity: pressed ? 0.85 : 1 })}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          minHeight: 84,
          borderRadius: radius.lg,
          backgroundColor: t.infoBg,
          paddingRight: space.lg,
        }}
      >
        {/* Standing ON the card: feet on its bottom edge, head above its top.
            The negative margin is what makes it a character in the scene
            rather than an icon in a box. */}
        <View style={{ width: 96, marginTop: -30, alignItems: 'center' }}>
          <NomiCharacter state="idle" size={104} active={focused} />
        </View>
        <View style={{ flex: 1, gap: space.hair, alignSelf: 'center', paddingVertical: space.md }}>
          <Text style={[type.bodyStrong, { color: t.infoText }]}>Nomi</Text>
          <Text style={[type.body, { color: t.infoText }]}>{line}</Text>
        </View>
      </View>
    </Pressable>
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
        <Text style={[type.body, { color: t.textMuted }]}>Thinking…</Text>
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
  const canSend = !busy && isAskable(draft);

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
        maxLength={MAX_QUESTION_CHARS}
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
