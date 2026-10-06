import { useMemo } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Card, Screen } from '../../src/ui/components';
import { ChatRoom } from '../../src/ui/chat-room';
import { ChatSplit } from '../../src/ui/inbox';
import { useTheme } from '../../src/ui/theme';
import {
  CommunityUnavailableError,
  deleteMessageForEveryone,
  editMessage,
  hideMessage,
  listMessages,
  listReactions,
  react,
  sendMessage,
} from '../../src/data/community';
import { useSessionStore } from '../../src/data/session';
import { CHAT_POLL_MS, quoteOf } from '../../src/core/messages';
import { authorName } from '../../src/core/community';

/**
 * The Everyone room — one room that everyone signed in shares (NOTES §46).
 *
 * It was the Chat pane of Community until messages between friends arrived
 * (NOTES §53); Chat is an inbox now, with this room at the top of it. Same
 * room, same data, same four-second poll — only where it lives changed, and
 * `ChatRoom` (src/ui/chat-room.tsx) is the same code a conversation with a
 * friend uses.
 */

export default function EveryoneRoom() {
  const t = useTheme();
  const queryClient = useQueryClient();
  const myId = useSessionStore((s) => s.session?.user.id ?? '');

  const { data: messages = [], isLoading, error } = useQuery({
    queryKey: ['global-chat'],
    queryFn: () => listMessages(),
    refetchInterval: CHAT_POLL_MS,
    retry: (count, err) => !(err instanceof CommunityUnavailableError) && count < 1,
  });
  const { data: reactions = [] } = useQuery({
    queryKey: ['chat-reactions'],
    queryFn: () => listReactions(),
    refetchInterval: CHAT_POLL_MS,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['global-chat'] });
    await queryClient.invalidateQueries({ queryKey: ['chat-reactions'] });
  };

  // Each reply with the message it answers, named (NOTES §58).
  const roomMessages = useMemo(
    () =>
      messages.map((m) => ({
        ...m,
        quote: quoteOf(m.reply_to, m.reply_body, m.reply_author_id === myId ? 'You' : authorName(m.reply_name ?? null)),
      })),
    [messages, myId],
  );

  if (error instanceof CommunityUnavailableError) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Everyone' }} />
        <Card>
          <Body>The chat isn&apos;t switched on yet.</Body>
          <Body muted>Nothing is missing from your account — this part of the app just needs to be set up.</Body>
        </Card>
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ title: 'Everyone' }} />
      {/* The chat list beside it, on a wide window (NOTES §74). */}
      <ChatSplit current="everyone">
        <ChatRoom
          messages={roomMessages}
          loading={isLoading}
          myId={myId}
          reactions={reactions}
          empty={{
            title: 'Nobody has said anything yet',
            detail: 'This is one room, and everyone signed in to Nomi is in it.',
          }}
          placeholder="Say something"
          reportKind="message"
          showNames
          hideDetail="It stays in the room for everyone else — only the person who sent it can take it back."
          editNote="Everyone will see it marked as edited."
          actions={{
            send: (text, replyTo) => sendMessage(text, replyTo),
            edit: editMessage,
            unsendEveryone: deleteMessageForEveryone,
            hideForMe: hideMessage,
            react,
          }}
          onChanged={refresh}
        />
      </ChatSplit>
    </View>
  );
}
