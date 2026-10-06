import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Body, Card, Label, LoadingState, Notice, Rows } from './components';
import { PersonAvatar } from './avatar';
import { PersonRow } from './people';
import { Sheet, SheetActions, SheetTitle } from './sheet';
import { Icon } from './glyphs';
import { INPUT_FONT_SIZE, NO_FOCUS_RING, radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import { describeWhen } from '../core/chat';
import { listConversations, MessagesUnavailableError, startConversation } from '../data/messages';
import { listGroups } from '../data/groups';
import { badgeLabel, INBOX_POLL_MS, lastLine } from '../core/messages';
import { groupLastLine, inboxMatches, matchesQuery, mergeInbox, type InboxEntry } from '../core/groups';
import { listFriendLinks } from '../data/social';
import { personName, splitFriends } from '../core/social';
import { useSessionStore } from '../data/session';
import { CHAT_LIST_WIDTH, showChatList } from '../core/chat-split';

/**
 * Chat, as an inbox (NOTES §53, the owner's choice; redrawn in §58 from his
 * picture): "Search messages" at the top, the Everyone room, then your
 * conversations with friends and your groups together, newest first, the
 * unread ones in bold with a count — the way Messenger lists them. Rows with a
 * hairline between them, not a stack of boxes.
 *
 * The pencil in the Community tab's top bar (`composing`) opens a new
 * message: a friend, or a new group.
 *
 * The Everyone room used to BE this list. It is a screen of its own now
 * (`app/messages/everyone.tsx`), and so is each conversation and each group;
 * all three are the same `ChatRoom`. Since NOTES §74 the list is also drawn
 * beside an open chat on a wide window (`ChatSplit`), so it lives here rather
 * than in the Community tab, and it has no scrolling column of its own.
 */
export function InboxList({
  composing = false,
  onCloseCompose,
  current,
  replace = false,
}: {
  composing?: boolean;
  onCloseCompose?: () => void;
  /** The chat open beside the list: 'everyone', a conversation's id or a group's. */
  current?: string;
  /** Open a chat in place of the one beside the list, not on top of it. */
  replace?: boolean;
}) {
  const t = useTheme();
  const router = useRouter();
  const myId = useSessionStore((s) => s.session?.user.id ?? '');
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  // Beside an open chat, another chat replaces it: Back still goes to where
  // the chats were opened from, not through every chat looked at.
  const go = (href: Href) => (replace ? router.replace(href) : router.push(href));

  const inbox = useQuery({
    queryKey: ['conversations'],
    queryFn: () => listConversations(),
    refetchInterval: INBOX_POLL_MS,
    retry: (count, err) => !(err instanceof MessagesUnavailableError) && count < 1,
  });
  // Empty before 0032, so the inbox is conversations alone until then.
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => listGroups(), refetchInterval: INBOX_POLL_MS });
  const off = inbox.error instanceof MessagesUnavailableError;
  const entries = useMemo(() => mergeInbox(inbox.data ?? [], groups.data ?? []), [inbox.data, groups.data]);
  const shown = entries.filter((e) => inboxMatches(e, query, entryName(e)));
  const everyoneShown = matchesQuery(query, ['Everyone', 'The room everyone signed in shares']);

  // Friends to start a conversation with — only asked for when the picker opens.
  const friends = useQuery({
    queryKey: ['friend-links'],
    queryFn: () => listFriendLinks(),
    enabled: composing,
  });
  const start = useMutation({
    mutationFn: (personId: string) => startConversation(personId),
    onSuccess: (conversationId) => {
      onCloseCompose?.();
      router.push(`/messages/${conversationId}`);
    },
  });

  const now = Date.now();

  return (
    <>
      {/* At the top of what it searches — the owner's first example of what
          the redesign fixes (search at the bottom of Profile). The inbox is
          on the phone already, so nothing is sent anywhere to search it. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          minHeight: TOUCH_TARGET,
          paddingHorizontal: space.md,
          borderRadius: radius.pill,
          backgroundColor: t.card,
          borderWidth: 1,
          borderColor: searchFocused ? t.accent : t.border,
        }}
      >
        <Icon name="search" color={t.textMuted} size={20} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search messages"
          placeholderTextColor={t.textMuted}
          accessibilityLabel="Search messages"
          autoCapitalize="none"
          autoCorrect={false}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          // The pill's edge turns accent as the focus mark.
          style={[{ flex: 1, minHeight: TOUCH_TARGET, color: t.text, fontSize: INPUT_FONT_SIZE }, NO_FOCUS_RING]}
        />
        {query ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear the search" onPress={() => setQuery('')} hitSlop={10}>
            <Icon name="close" color={t.textMuted} size={18} />
          </Pressable>
        ) : null}
      </View>

      {off ? (
        <Card>
          <Body>Messages to friends aren&apos;t switched on yet.</Body>
          <Body muted>The Everyone room works as normal.</Body>
        </Card>
      ) : null}
      {inbox.isLoading ? <LoadingState /> : null}

      <Rows>
        {/* The room everyone shares, always first. */}
        {everyoneShown ? (
          <InboxRow
            label="Everyone. The room everyone signed in shares."
            leading={<GroupBadge />}
            title="Everyone"
            line="The room everyone signed in shares"
            trailing={<Icon name="forward" color={t.textMuted} size={20} />}
            selected={current === 'everyone'}
            onPress={() => go('/messages/everyone')}
          />
        ) : null}
        {shown.map((e) =>
          e.kind === 'dm' ? (
            <InboxRow
              key={e.item.id}
              label={`${entryName(e)}. ${lastLine(e.item, myId)}${e.item.unread > 0 ? `. ${e.item.unread} new` : ''}`}
              leading={<PersonAvatar avatar={e.item.avatar} userId={e.item.person_id} name={entryName(e)} size={48} />}
              title={entryName(e)}
              line={lastLine(e.item, myId)}
              when={e.item.last_at ? describeWhen(Date.parse(e.item.last_at), now) : ''}
              unread={e.item.unread}
              selected={current === e.item.id}
              onPress={() => go(`/messages/${e.item.id}`)}
            />
          ) : (
            <InboxRow
              key={e.item.id}
              label={`${e.item.title}, a group. ${groupLastLine(e.item, myId)}${e.item.unread > 0 ? `. ${e.item.unread} new` : ''}`}
              leading={<GroupBadge />}
              title={e.item.title}
              line={groupLastLine(e.item, myId)}
              when={e.item.last_at ? describeWhen(Date.parse(e.item.last_at), now) : ''}
              unread={e.item.unread}
              selected={current === e.item.id}
              onPress={() => go(`/groups/${e.item.id}`)}
            />
          ),
        )}
      </Rows>

      {inbox.data && entries.length === 0 ? (
        <Body muted>No conversations yet. Start one with the pencil above, or from a friend&apos;s profile.</Body>
      ) : null}
      {query && shown.length === 0 && !everyoneShown ? <Body muted>{`Nothing matches "${query.trim()}".`}</Body> : null}

      {composing && onCloseCompose ? (
        <Sheet onClose={onCloseCompose}>
          <SheetTitle>New message</SheetTitle>
          <SheetActions
            actions={[
              {
                icon: 'people',
                label: 'New group',
                detail: 'A chat with several of your friends at once',
                onPress: () => {
                  onCloseCompose();
                  router.push('/groups/new');
                },
              },
            ]}
          />
          <Label>Or message a friend</Label>
          {start.isError ? <Notice tone="error">{(start.error as Error).message}</Notice> : null}
          {friends.isLoading ? <LoadingState /> : null}
          {friends.data && splitFriends(friends.data).friends.length === 0 ? (
            <Body muted>You can message friends. Add some from your Profile first.</Body>
          ) : null}
          <Rows card>
            {splitFriends(friends.data ?? []).friends.map((f) => (
              <PersonRow
                key={f.id}
                id={f.person_id}
                name={f.name}
                username={f.username}
                avatar={f.avatar}
                inset
                onPress={() => start.mutate(f.person_id)}
              />
            ))}
          </Rows>
        </Sheet>
      ) : null}
    </>
  );
}

/**
 * An open chat, with the chat list beside it on a wide window (NOTES §74). On
 * a phone or a narrow window it is the chat alone, as it always was.
 */
export function ChatSplit({ current, children }: { current: string; children: ReactNode }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  if (!showChatList(width)) return <>{children}</>;
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <ScrollView
        style={{ width: CHAT_LIST_WIDTH, flexGrow: 0, borderRightWidth: 1, borderRightColor: t.border }}
        contentContainerStyle={{ padding: space.md, gap: space.md }}
        keyboardShouldPersistTaps="handled"
      >
        <InboxList current={current} replace />
      </ScrollView>
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

/** A conversation's other person, or a group's name. */
function entryName(e: InboxEntry): string {
  return e.kind === 'dm' ? personName({ name: e.item.name, username: e.item.username }) : e.item.title;
}

/** A group's face: people in a circle — the Everyone room's, and every group's. */
function GroupBadge() {
  const t = useTheme();
  return (
    <View
      style={{
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: t.card,
      }}
    >
      <Icon name="people" color={t.accent} size={24} />
    </View>
  );
}

/**
 * One row of the inbox: a face, the name, the last line, and on the right when
 * and how many are new — the owner's picture. Bold AND counted when new,
 * never colour alone. The open chat's row, beside it, is filled in.
 */
function InboxRow({
  label,
  leading,
  title,
  line,
  when,
  unread = 0,
  trailing,
  selected = false,
  onPress,
}: {
  label: string;
  leading: ReactNode;
  title: string;
  line: string;
  when?: string;
  unread?: number;
  trailing?: ReactNode;
  selected?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const isNew = unread > 0;
  const badge = badgeLabel(unread);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingVertical: space.md,
        // Filled, not only coloured: the open chat stands out by its shape.
        ...(selected ? { backgroundColor: t.card, borderRadius: radius.md, paddingHorizontal: space.sm } : null),
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[isNew ? type.bodyStrong : type.body, { color: t.text, fontWeight: isNew ? '700' : '600' }]} numberOfLines={1}>
          {title}
        </Text>
        <Text
          style={[type.caption, { color: isNew ? t.text : t.textMuted, fontWeight: isNew ? '700' : '400' }]}
          numberOfLines={1}
        >
          {line}
        </Text>
      </View>
      {trailing ?? (
        <View style={{ alignItems: 'flex-end', gap: space.xs, minWidth: 48 }}>
          {when ? <Text style={[type.caption, { color: isNew ? t.accent : t.textMuted }]}>{when}</Text> : null}
          {badge ? <CountBadge label={badge} /> : null}
        </View>
      )}
    </Pressable>
  );
}

/** A small count — on a conversation here, and on the Community tab. */
export function CountBadge({ label }: { label: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        minWidth: 20,
        height: 20,
        paddingHorizontal: 6,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: t.accent,
      }}
    >
      <Text style={[type.caption, { color: t.accentText, fontWeight: '700' }]}>{label}</Text>
    </View>
  );
}
