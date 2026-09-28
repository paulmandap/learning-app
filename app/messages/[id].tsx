import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoadingState, Screen } from '../../src/ui/components';
import { StatePanel } from '../../src/ui/states';
import { ChatRoom, type RoomMessage } from '../../src/ui/chat-room';
import { OverflowMenu } from '../../src/ui/menu';
import { BlockSheet, ReportSheet } from '../../src/ui/people';
import { type, useTheme } from '../../src/ui/theme';
import {
  editDirectMessage,
  getConversation,
  hideDirectMessage,
  listDirectMessages,
  listDirectReactions,
  markConversationRead,
  MessagesUnavailableError,
  reactToDirectMessage,
  sendDirectMessage,
  unsendDirectMessage,
} from '../../src/data/messages';
import { CHAT_POLL_MS, CLOSED_CONVERSATION, seenMessageId } from '../../src/core/messages';
import { personName } from '../../src/core/social';
import { useSessionStore } from '../../src/data/session';

/**
 * A conversation with a friend (NOTES §53).
 *
 * The Everyone room's `ChatRoom`, between two people: no names over the
 * bubbles, "Seen" under your last message once they have read it, and — when
 * you are not friends any more — the conversation still there to read, with
 * the reason in place of the box to type in.
 *
 * Opening it marks it read, and so does every new message that arrives while
 * it is open: an unread count for a conversation you are looking at is a badge
 * that lies.
 */
export default function Conversation() {
  const t = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = String(id);
  const myId = useSessionStore((s) => s.session?.user.id ?? '');

  const conversation = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => getConversation(conversationId),
    refetchInterval: CHAT_POLL_MS,
  });
  const messages = useQuery({
    queryKey: ['direct-messages', conversationId],
    queryFn: () => listDirectMessages(conversationId),
    refetchInterval: CHAT_POLL_MS,
    enabled: !!conversation.data,
  });
  const ids = useMemo(() => (messages.data ?? []).map((m) => m.id), [messages.data]);
  const reactions = useQuery({
    queryKey: ['direct-reactions', conversationId, ids],
    queryFn: () => listDirectReactions(ids),
    enabled: ids.length > 0,
    refetchInterval: CHAT_POLL_MS,
  });

  const [reporting, setReporting] = useState(false);
  const [blocking, setBlocking] = useState(false);

  const who = conversation.data;
  const name = who ? personName({ name: who.name, username: who.username }) : '';

  // Read, whenever something unread is on screen.
  const unread = who?.unread ?? 0;
  useEffect(() => {
    if (!who || unread === 0) return;
    void markConversationRead(conversationId).then(async () => {
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      await queryClient.invalidateQueries({ queryKey: ['dm-unread'] });
      await queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
    });
  }, [who, unread, conversationId, queryClient]);

  const roomMessages: RoomMessage[] = useMemo(
    () =>
      (messages.data ?? []).map((m) => ({
        id: m.id,
        author_id: m.author_id,
        author_name: m.author_id === myId ? null : name,
        author_avatar: m.author_id === myId ? null : (who?.avatar ?? null),
        body: m.body,
        created_at: m.created_at,
        edited_at: m.edited_at,
      })),
    [messages.data, myId, name, who?.avatar],
  );
  // Names for the reaction chips' labels: two people, both known.
  const named = useMemo(
    () => (reactions.data ?? []).map((r) => ({ ...r, name: r.user_id === myId ? null : name })),
    [reactions.data, myId, name],
  );

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['direct-messages', conversationId] });
    await queryClient.invalidateQueries({ queryKey: ['direct-reactions', conversationId] });
    await queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
    await queryClient.invalidateQueries({ queryKey: ['conversations'] });
  };

  if (conversation.isLoading) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '' }} />
        <LoadingState />
      </Screen>
    );
  }

  // Gone, not yours, or across a block — the same answer, as for a person's page.
  if (!who) {
    return (
      <Screen centered>
        <Stack.Screen options={{ title: '' }} />
        <StatePanel
          kind="empty"
          title={conversation.error instanceof MessagesUnavailableError ? "Messages aren't switched on yet" : "This conversation isn't here"}
          detail="Your other conversations are in Community, under Chat."
          action={{ label: 'Back to your messages', onPress: () => router.replace('/community') }}
        />
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen
        options={{
          // Their name, which opens their page — where a messenger puts it.
          headerTitle: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${name}'s profile`}
              onPress={() => router.push(`/person/${who.person_id}`)}
            >
              <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>
                {name}
              </Text>
            </Pressable>
          ),
          headerRight: () => (
            <OverflowMenu
              accessibilityLabel={`More about ${name}`}
              items={[
                { icon: 'person', label: `See ${name}'s profile`, onPress: () => router.push(`/person/${who.person_id}`) },
                { icon: 'report', label: `Report ${name}`, destructive: true, onPress: () => setReporting(true) },
                { icon: 'block', label: `Block ${name}`, destructive: true, onPress: () => setBlocking(true) },
              ]}
            />
          ),
        }}
      />
      <ChatRoom
        messages={roomMessages}
        loading={messages.isLoading}
        myId={myId}
        reactions={named}
        empty={{ title: `Say hello to ${name}`, detail: 'Only the two of you can see this conversation.' }}
        placeholder={`Message ${name}`}
        reportKind="direct_message"
        showNames={false}
        seenId={seenMessageId(messages.data ?? [], myId, who.their_read_at)}
        closed={who.can_send ? null : CLOSED_CONVERSATION}
        hideDetail={`It stays for ${name} — only the person who sent it can take it back.`}
        editNote={`${name} will see it marked as edited.`}
        actions={{
          send: (text) => sendDirectMessage(conversationId, text),
          edit: editDirectMessage,
          unsendEveryone: unsendDirectMessage,
          hideForMe: hideDirectMessage,
          react: reactToDirectMessage,
        }}
        onChanged={refresh}
      />

      {reporting ? (
        <ReportSheet
          kind="person"
          targetId={who.person_id}
          name={name}
          onBlock={() => {
            setReporting(false);
            setBlocking(true);
          }}
          onClose={() => setReporting(false)}
        />
      ) : null}
      {blocking ? (
        <BlockSheet
          personId={who.person_id}
          name={name}
          // The conversation goes with the block — for both of you.
          onBlocked={() => router.replace('/community')}
          onClose={() => setBlocking(false)}
        />
      ) : null}
    </View>
  );
}
