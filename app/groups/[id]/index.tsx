import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoadingState, Screen } from '../../../src/ui/components';
import { StatePanel } from '../../../src/ui/states';
import { ChatRoom, type RoomMessage } from '../../../src/ui/chat-room';
import { OverflowMenu } from '../../../src/ui/menu';
import { LeaveSheet } from '../../../src/ui/group-sheets';
import { Icon } from '../../../src/ui/glyphs';
import { space, type, useTheme } from '../../../src/ui/theme';
import {
  editGroupMessage,
  getGroup,
  GroupsUnavailableError,
  hideGroupMessage,
  leaveGroup,
  listGroupMessages,
  listGroupReactions,
  markGroupRead,
  reactToGroupMessage,
  sendGroupMessage,
  unsendGroupMessage,
} from '../../../src/data/groups';
import { authorName } from '../../../src/core/community';
import { peopleLine } from '../../../src/core/groups';
import { CHAT_POLL_MS, quoteOf } from '../../../src/core/messages';
import { useSessionStore } from '../../../src/data/session';

/**
 * A group (NOTES §58, migration 0032).
 *
 * The same `ChatRoom` as the Everyone room and a conversation with a friend —
 * the bubbles, the menu, replies, reactions, report and block are one
 * implementation — with names over the bubbles, since there are more than two
 * of you. Its name at the top opens who is in it, where it can be renamed and
 * people added or removed.
 *
 * Opening it marks it read, and so does anything new arriving while it is
 * open, as a conversation does.
 */
export default function GroupRoom() {
  const t = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = String(id);
  const myId = useSessionStore((s) => s.session?.user.id ?? '');
  const [leaving, setLeaving] = useState(false);

  const group = useQuery({
    queryKey: ['group', groupId],
    queryFn: () => getGroup(groupId),
    refetchInterval: CHAT_POLL_MS,
  });
  const messages = useQuery({
    queryKey: ['group-messages', groupId],
    queryFn: () => listGroupMessages(groupId),
    refetchInterval: CHAT_POLL_MS,
    enabled: !!group.data,
  });
  const ids = useMemo(() => (messages.data ?? []).map((m) => m.id), [messages.data]);
  const reactions = useQuery({
    queryKey: ['group-reactions', groupId, ids],
    queryFn: () => listGroupReactions(ids),
    enabled: ids.length > 0,
    refetchInterval: CHAT_POLL_MS,
  });

  const g = group.data;
  const unread = g?.unread ?? 0;
  useEffect(() => {
    if (!g || unread === 0) return;
    void markGroupRead(groupId).then(async () => {
      await queryClient.invalidateQueries({ queryKey: ['groups'] });
      await queryClient.invalidateQueries({ queryKey: ['dm-unread'] });
      await queryClient.invalidateQueries({ queryKey: ['group', groupId] });
    });
  }, [g, unread, groupId, queryClient]);

  const roomMessages: RoomMessage[] = useMemo(
    () =>
      (messages.data ?? []).map((m) => ({
        id: m.id,
        author_id: m.author_id,
        author_name: m.author_name,
        author_avatar: m.author_avatar,
        body: m.body,
        created_at: m.created_at,
        edited_at: m.edited_at,
        quote: quoteOf(m.reply_to, m.reply_body, m.reply_author_id === myId ? 'You' : authorName(m.reply_name)),
      })),
    [messages.data, myId],
  );

  const leave = useMutation({
    mutationFn: () => leaveGroup(groupId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['groups'] });
      await queryClient.invalidateQueries({ queryKey: ['dm-unread'] });
      router.replace('/community');
    },
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['group-messages', groupId] });
    await queryClient.invalidateQueries({ queryKey: ['group-reactions', groupId] });
    await queryClient.invalidateQueries({ queryKey: ['group', groupId] });
    await queryClient.invalidateQueries({ queryKey: ['groups'] });
  };

  if (group.isLoading) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '' }} />
        <LoadingState />
      </Screen>
    );
  }

  // Gone, or you are not in it — the same answer, as for a conversation.
  if (!g) {
    return (
      <Screen centered>
        <Stack.Screen options={{ title: '' }} />
        <StatePanel
          kind="empty"
          title={group.error instanceof GroupsUnavailableError ? "Group chats aren't switched on yet" : "This group isn't here"}
          detail="You may have left it, or been taken out of it. Your other chats are in Community, under Chat."
          action={{ label: 'Back to your messages', onPress: () => router.replace('/community') }}
        />
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${g.title}, ${peopleLine(g.member_count)}. Who is in it`}
              onPress={() => router.push(`/groups/${groupId}/info`)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
            >
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: t.card,
                }}
              >
                <Icon name="people" color={t.accent} size={18} />
              </View>
              <View>
                <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>
                  {g.title}
                </Text>
                <Text style={[type.caption, { color: t.textMuted }]}>{peopleLine(g.member_count)}</Text>
              </View>
            </Pressable>
          ),
          headerRight: () => (
            <OverflowMenu
              accessibilityLabel={`More about ${g.title}`}
              items={[
                { icon: 'people', label: 'Who is in it', onPress: () => router.push(`/groups/${groupId}/info`) },
                { icon: 'addFriend', label: 'Add people', onPress: () => router.push(`/groups/${groupId}/info?add=1`) },
                { icon: 'close', label: 'Leave group', destructive: true, onPress: () => setLeaving(true) },
              ]}
            />
          ),
        }}
      />
      <ChatRoom
        messages={roomMessages}
        loading={messages.isLoading}
        myId={myId}
        reactions={reactions.data ?? []}
        empty={{ title: 'Say hello to the group', detail: 'Only the people in this group can see it.' }}
        placeholder={`Message ${g.title}`}
        reportKind="group_message"
        showNames
        hideDetail="It stays for everyone else in the group — only the person who sent it can take it back."
        editNote="Everyone in the group will see it marked as edited."
        actions={{
          send: (text, replyTo) => sendGroupMessage(groupId, text, replyTo),
          edit: editGroupMessage,
          unsendEveryone: unsendGroupMessage,
          hideForMe: hideGroupMessage,
          react: reactToGroupMessage,
        }}
        onChanged={refresh}
      />

      {leaving ? (
        <LeaveSheet
          title={g.title}
          owner={g.i_own}
          busy={leave.isPending}
          error={leave.error as Error | null}
          onLeave={() => leave.mutate()}
          onClose={() => setLeaving(false)}
        />
      ) : null}
    </View>
  );
}
