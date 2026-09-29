import { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionCard, ChatBubble, Composer, NomiWelcome, ThinkingBubble } from '../src/ui/nomi';
import { LoadingState, Rows } from '../src/ui/components';
import { Sheet, SheetTitle } from '../src/ui/sheet';
import { HeaderActions } from '../src/ui/menu';
import { Icon } from '../src/ui/glyphs';
import { CONTENT_MAX_WIDTH, space, TOUCH_TARGET, type, useTheme } from '../src/ui/theme';
import { useNomiConversation } from '../src/data/nomi-session';
import { useAssistantContext } from '../src/data/assistant-context';
import { deleteConversation, listConversations } from '../src/data/nomi-chat';
import { homeLine } from '../src/core/nomi-brain';
import { describeWhen } from '../src/core/chat';

/**
 * Nomi — a conversation.
 *
 * ## What the owner asked for
 *
 * *"a chatbot, capable of everyday chats, answering simple and direct, can have
 * a chat like sender receiver chat like messenger, not limited to 1 chat"*, with
 * a history *"just like what Claude website does"* — and, of the screen that was
 * here, *"there's TOO MUCH text/cards. too much descriptions! remove that."*
 * (NOTES §36.)
 *
 * So this screen is the chat and nothing else: messages, a box to type in, the
 * list of past conversations behind a button, and a fresh one behind another.
 * A new conversation opens with Nomi saying hello and one true line about the
 * student, not a description of what Nomi is.
 *
 * ## Two brains, one conversation
 *
 * `sendToNomi` answers questions about the student's own app from the app —
 * instantly, spending nothing — and everything else through Gemini with the
 * facts attached. The screen cannot tell which, and does not need to.
 */

const SUGGESTIONS = ["What's due today?", 'What should I study?', "What's my streak?", 'Quiz me on something'];

export default function Nomi() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const context = useAssistantContext((s) => s.context);
  const chat = useNomiConversation(context);
  const scroll = useRef<ScrollView>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const router = useRouter();

  const empty = chat.turns.length === 0 && !chat.busy && !chat.loading;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderActions
              actions={[
                { icon: 'recent', label: 'Your chats', onPress: () => setHistoryOpen(true) },
                { icon: 'compose', label: 'New chat', onPress: chat.startNew },
              ]}
            />
          ),
        }}
      />

      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, alignItems: 'center', padding: space.lg }}
        keyboardShouldPersistTaps="handled"
        // New messages arrive at the bottom, where a messenger keeps you.
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        <View
          style={{
            width: '100%',
            maxWidth: CONTENT_MAX_WIDTH,
            flexGrow: 1,
            gap: space.md,
            justifyContent: empty ? 'center' : 'flex-end',
          }}
        >
          {empty ? (
            <NomiWelcome
              name={chat.snapshot.name}
              line={homeLine(chat.snapshot, new Date().getHours())}
              suggestions={SUGGESTIONS}
              onPick={(text) => void chat.send(text)}
            />
          ) : (
            chat.turns.map((turn, i) => (
              <ChatBubble
                key={i}
                turn={turn}
                showOwl={turn.role === 'nomi' && chat.turns[i + 1]?.role !== 'nomi'}
              />
            ))
          )}
          {chat.busy ? <ThinkingBubble slow={chat.slow} /> : null}
          {/* What Nomi offered to do, and the tap that does it (NOTES §37).
              A set's cards are made on its own screen, so that is where a
              confirmed set goes. */}
          {chat.pending && !chat.busy ? (
            <ActionCard
              action={chat.pending}
              busy={chat.acting}
              onCount={chat.setCount}
              onDismiss={chat.dismiss}
              onConfirm={() =>
                void chat.confirm().then((done) => {
                  if (done?.openSetId) router.push(`/set/${done.openSetId}`);
                })
              }
            />
          ) : null}
          {/* Writing a reviewer takes a while, and it is Nomi doing the writing:
              thinking, pencil in wing (NOTES §50). */}
          {chat.acting && chat.pending?.kind === 'write_reviewer' ? <ThinkingBubble prop="pencil" /> : null}
          {chat.note ? (
            <Text style={[type.caption, { color: t.textMuted, textAlign: 'center' }]}>{chat.note}</Text>
          ) : null}
        </View>
      </ScrollView>

      <View
        style={{
          alignItems: 'center',
          paddingHorizontal: space.lg,
          paddingTop: space.sm,
          paddingBottom: insets.bottom + space.sm,
          borderTopWidth: 1,
          borderTopColor: t.border,
          backgroundColor: t.bg,
        }}
      >
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
          <Composer busy={chat.busy} onSend={(text) => void chat.send(text)} />
        </View>
      </View>

      <ChatHistory
        open={historyOpen}
        currentId={chat.conversationId}
        onClose={() => setHistoryOpen(false)}
        onOpen={(id) => {
          chat.open(id);
          setHistoryOpen(false);
        }}
        onDeleted={(id) => {
          if (id === chat.conversationId) chat.startNew();
        }}
      />
    </View>
  );
}

/**
 * Past conversations, newest first — open one, or delete it.
 *
 * The one Sheet since §60: it was a panel of its own from the top of the
 * screen, older than the redesign's rule that everything temporary rises from
 * the bottom over the dimmed, blurred page.
 */
function ChatHistory({
  open,
  currentId,
  onClose,
  onOpen,
  onDeleted,
}: {
  open: boolean;
  currentId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTheme();
  const client = useQueryClient();
  const { data: conversations, isLoading } = useQuery({
    queryKey: ['nomi-conversations'],
    queryFn: () => listConversations(),
    enabled: open,
  });

  async function remove(id: string) {
    await deleteConversation(id);
    onDeleted(id);
    await client.invalidateQueries({ queryKey: ['nomi-conversations'] });
  }

  if (!open) return null;

  return (
    <Sheet onClose={onClose}>
      <SheetTitle>Your chats</SheetTitle>

      {isLoading ? (
        <LoadingState />
      ) : conversations === null ? (
        <Text style={[type.body, { color: t.textMuted }]}>
          Saved chats aren't switched on yet. This conversation lasts until you close the app.
        </Text>
      ) : (conversations ?? []).length === 0 ? (
        <Text style={[type.body, { color: t.textMuted }]}>No saved chats yet.</Text>
      ) : (
        <Rows card>
          {(conversations ?? []).map((c) => {
            const current = c.id === currentId;
            return (
              <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${c.title || 'Chat'}${current ? ', open now' : ''}`}
                  onPress={() => onOpen(c.id)}
                  style={({ pressed }) => ({
                    flex: 1,
                    minHeight: TOUCH_TARGET + space.sm,
                    justifyContent: 'center',
                    paddingVertical: space.sm,
                    paddingLeft: space.lg,
                    backgroundColor: pressed ? t.bg : 'transparent',
                  })}
                >
                  <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>
                    {c.title || 'Chat'}
                  </Text>
                  {/* Which one is open, in words — not a shade alone. */}
                  <Text style={[type.caption, { color: current ? t.accent : t.textMuted }]}>
                    {current ? 'Open now' : describeWhen(Date.parse(c.updated_at), Date.now())}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${c.title || 'this chat'}`}
                  onPress={() => void remove(c.id)}
                  style={{ minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center', marginRight: space.sm }}
                >
                  <Icon name="trash" color={t.danger} size={20} />
                </Pressable>
              </View>
            );
          })}
        </Rows>
      )}
    </Sheet>
  );
}
