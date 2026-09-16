import { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Card, LoadingState, Notice, Title } from '../../src/ui/components';
import { StatePanel } from '../../src/ui/states';
import { Segment } from '../../src/ui/segment';
import { Composer } from '../../src/ui/nomi';
import { PersonAvatar } from '../../src/ui/avatar';
import { CONTENT_MAX_WIDTH, radius, space, TOUCH_TARGET, type, useTheme } from '../../src/ui/theme';
import {
  authorName,
  browseOrder,
  MESSAGE_MAX_LENGTH,
  rankSets,
  starLabel,
  canStar,
  type PublicSet,
} from '../../src/core/community';
import { describeWhen } from '../../src/core/chat';
import {
  CommunityUnavailableError,
  deleteMessage,
  listMessages,
  listPublicSets,
  myStars,
  sendMessage,
  star,
  unstar,
} from '../../src/data/community';
import { useSessionStore } from '../../src/data/session';

/**
 * Community — sets people have shared, which of them are best, and one room to
 * talk in.
 *
 * ## What it is, and what it deliberately is not
 *
 * Three segments rather than three tabs. Six tabs at 393px is about 65 points
 * each, which is where the labels stop fitting and a bottom bar becomes the
 * icon-only guessing game `app/(tabs)/_layout.tsx` rejects on purpose. These
 * three belong together anyway — they are all "other people".
 *
 * There are no profiles to visit, no following, no replies and no direct
 * messages. Five people who already know each other do not need a social
 * network; they need to see what the others made, say which of it was good,
 * and talk. Every one of those absences is a thing that would need moderating.
 *
 * ## Nothing here is the study path
 *
 * Tapping a shared set opens the ordinary set screen, which reads it through
 * `readableSet` and knows it is not yours. Studying it is studying it — the
 * same decks, the same schedule, your own answers. This screen only finds it.
 */

type Pane = 'sets' | 'top' | 'chat';

const PANES = [
  { key: 'sets' as const, label: 'Sets' },
  { key: 'top' as const, label: 'Top sets' },
  { key: 'chat' as const, label: 'Chat' },
];

/**
 * How often the chat asks for new messages while you are looking at it.
 *
 * Polling, not Supabase's realtime channels. Realtime would be live rather than
 * four-seconds-late and costs no new dependency — it is already inside
 * supabase-js — but it is a second transport with its own connection states,
 * its own reconnection behaviour and its own failure that looks like silence,
 * for five people in one room. A query with an interval is the same TanStack
 * Query path as every other read in the app, and it stops when the screen is
 * not on top (`refetchIntervalInBackground` defaults to false), so a phone in a
 * pocket asks for nothing.
 *
 * Worth revisiting on evidence: if the room is ever busy enough that
 * four seconds reads as broken, that is the measurement that reopens it.
 */
const CHAT_POLL_MS = 4000;

export default function Community() {
  const t = useTheme();
  const [pane, setPane] = useState<Pane>('sets');

  return (
    // Not `Screen`: the chat needs a bounded scroll area with the box to type in
    // pinned under it, and `Screen` is one ScrollView around everything — the
    // composer would scroll away with the messages. TabSlot gives this flex:1,
    // which is what bounds the pane below (NOTES §33).
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.lg }}>
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: space.md }}>
          <Title>Community</Title>
          <Segment value={pane} options={PANES} onChange={setPane} />
        </View>
      </View>

      {pane === 'chat' ? <ChatPane /> : <SetsPane ranked={pane === 'top'} />}
    </View>
  );
}

// ------------------------------------------------------------ shared sets --

function SetsPane({ ranked }: { ranked: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const myId = useSessionStore((s) => s.session?.user.id ?? '');

  const { data: sets, isLoading, error } = useQuery({
    queryKey: ['public-sets'],
    queryFn: () => listPublicSets(),
    // A missing view is a migration that has not been applied, not a blip —
    // the same rule the notebook follows.
    retry: (count, err) => !(err instanceof CommunityUnavailableError) && count < 1,
  });

  const { data: starred } = useQuery({
    queryKey: ['my-stars'],
    queryFn: () => myStars(),
    retry: (count, err) => !(err instanceof CommunityUnavailableError) && count < 1,
  });

  const toggleStar = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => (on ? star(id) : unstar(id)),
    // Both lists change: the star on the row, and the order of the ranking.
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['my-stars'] });
      await queryClient.invalidateQueries({ queryKey: ['public-sets'] });
    },
  });

  // `rank` is present only in the ranking. Typed as optional here rather than
  // narrowed at the call site, because `'rank' in set` widens the value to
  // unknown and the row would then take a number it could not check.
  const shown: (PublicSet & { rank?: number })[] = useMemo(
    () => (ranked ? rankSets(sets ?? []) : browseOrder(sets ?? [])),
    [sets, ranked],
  );

  if (isLoading) return <Pane><LoadingState /></Pane>;
  if (error instanceof CommunityUnavailableError) return <Pane><NotSwitchedOn /></Pane>;
  if (error) {
    return (
      <Pane>
        <Notice tone="error">Couldn&apos;t load what people have shared. Try again in a moment.</Notice>
      </Pane>
    );
  }

  if (shown.length === 0) {
    return (
      <Pane>
        <StatePanel
          kind="empty"
          title={ranked ? 'No stars yet' : 'Nothing shared yet'}
          detail={
            ranked
              ? 'When someone stars a shared set, the best ones show up here.'
              : 'Open one of your sets and share it, and everyone will find it here.'
          }
        />
      </Pane>
    );
  }

  return (
    <Pane>
      {toggleStar.isError ? (
        <Notice tone="error">{(toggleStar.error as Error).message}</Notice>
      ) : null}

      {shown.map((set) => (
        <SharedSetRow
          key={set.id}
          set={set}
          rank={set.rank}
          starred={starred?.has(set.id) ?? false}
          mine={set.owner_id === myId}
          canStar={canStar(set, myId)}
          busy={toggleStar.isPending && toggleStar.variables?.id === set.id}
          onOpen={() => router.push(`/set/${set.id}`)}
          onToggleStar={(on) => toggleStar.mutate({ id: set.id, on })}
        />
      ))}
    </Pane>
  );
}

/**
 * One shared set.
 *
 * Not `ListRow`, which is a title, a line of meta and a chevron. This row has a
 * control in it — the star — and a control inside a row that is itself a button
 * needs the two touch targets kept apart, or starring something opens it
 * instead. Hence the star as its own Pressable beside the pressable row rather
 * than inside it.
 */
function SharedSetRow({
  set,
  rank,
  starred,
  mine,
  canStar: starrable,
  busy,
  onOpen,
  onToggleStar,
}: {
  set: PublicSet;
  rank?: number;
  starred: boolean;
  mine: boolean;
  canStar: boolean;
  busy: boolean;
  onOpen: () => void;
  onToggleStar: (on: boolean) => void;
}) {
  const t = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        padding: space.md,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.card,
      }}
    >
      {rank !== undefined ? (
        // The number, not a medal: three medals and then a run of grey numbers
        // says "you lost" to everyone below third, in a room of five people.
        <Text style={[type.bodyStrong, { color: t.textMuted, minWidth: 24 }]}>{rank}</Text>
      ) : null}

      <PersonAvatar
        avatar={set.owner_avatar}
        userId={set.owner_id}
        name={authorName(set.owner_name)}
        size={32}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${set.title}, by ${authorName(set.owner_name)}, ${starLabel(set.stars)}`}
        onPress={onOpen}
        style={({ pressed }) => ({ flex: 1, gap: 2, opacity: pressed ? 0.7 : 1 })}
      >
        <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={2}>
          {set.title}
        </Text>
        <Text style={[type.caption, { color: t.textMuted }]}>
          {mine ? 'Shared by you' : `by ${authorName(set.owner_name)}`} · {set.cards} card
          {set.cards === 1 ? '' : 's'}
        </Text>
      </Pressable>

      <StarButton
        count={set.stars}
        on={starred}
        disabled={!starrable || busy}
        // Your own set shows its count and cannot be tapped. Saying why in a
        // label rather than hiding the number: the owner still wants to see it.
        reason={mine ? 'Your own set' : undefined}
        onPress={() => onToggleStar(!starred)}
      />
    </View>
  );
}

function StarButton({
  count,
  on,
  disabled,
  reason,
  onPress,
}: {
  count: number;
  on: boolean;
  disabled: boolean;
  reason?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled }}
      accessibilityLabel={reason ?? `${on ? 'Remove your star' : 'Star this set'}, ${starLabel(count)}`}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => ({
        minWidth: TOUCH_TARGET,
        minHeight: TOUCH_TARGET,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        opacity: pressed ? 0.7 : disabled ? 0.55 : 1,
      })}
    >
      {/* Filled or hollow as well as coloured — never hue alone, the same rule
          the quiz options follow. */}
      <Text style={{ fontSize: 19, color: on ? t.accent : t.textMuted }}>{on ? '★' : '☆'}</Text>
      <Text style={[type.caption, { color: on ? t.accent : t.textMuted }]}>{count}</Text>
    </Pressable>
  );
}

// ------------------------------------------------------------------- chat --

function ChatPane() {
  const t = useTheme();
  const queryClient = useQueryClient();
  const myId = useSessionStore((s) => s.session?.user.id ?? '');
  const scroll = useRef<ScrollView>(null);
  const now = Date.now();

  const { data: messages = [], isLoading, error } = useQuery({
    queryKey: ['global-chat'],
    queryFn: () => listMessages(),
    refetchInterval: CHAT_POLL_MS,
    retry: (count, err) => !(err instanceof CommunityUnavailableError) && count < 1,
  });

  const send = useMutation({
    mutationFn: (text: string) => sendMessage(text),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['global-chat'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteMessage(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['global-chat'] }),
  });

  if (error instanceof CommunityUnavailableError) return <Pane><NotSwitchedOn /></Pane>;

  return (
    <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: space.lg }}>
      <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        <ScrollView
          ref={scroll}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingVertical: space.md, gap: space.md }}
          keyboardShouldPersistTaps="handled"
          // New messages arrive at the bottom, where a messenger keeps you —
          // the same behaviour as Nomi's chat, so the app has one idea of what
          // a conversation looks like.
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        >
          {isLoading ? (
            <LoadingState what="Loading messages…" />
          ) : messages.length === 0 ? (
            <StatePanel
              kind="empty"
              title="Nobody has said anything yet"
              detail="This is one room, and everyone signed in to Nomi is in it."
            />
          ) : (
            messages.map((m) => (
              <Message
                key={m.id}
                name={authorName(m.author_name)}
                avatar={m.author_avatar}
                userId={m.author_id}
                body={m.body}
                when={describeWhen(Date.parse(m.created_at), now)}
                mine={m.author_id === myId}
                onDelete={() => remove.mutate(m.id)}
              />
            ))
          )}
        </ScrollView>

        {send.isError ? (
          <View style={{ paddingBottom: space.sm }}>
            <Notice tone="error">{(send.error as Error).message}</Notice>
          </View>
        ) : null}

        <View style={{ paddingBottom: space.lg, backgroundColor: t.bg }}>
          <Composer
            onSend={(text) => send.mutate(text)}
            busy={send.isPending}
            placeholder="Say something"
            // The database refuses anything longer, so the box stops there
            // rather than letting someone type a page and then be told no.
            maxLength={MESSAGE_MAX_LENGTH}
          />
        </View>
      </View>
    </View>
  );
}

function Message({
  name,
  avatar,
  userId,
  body,
  when,
  mine,
  onDelete,
}: {
  name: string;
  avatar: string | null;
  userId: string;
  body: string;
  when: string;
  mine: boolean;
  onDelete: () => void;
}) {
  const t = useTheme();

  return (
    <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
      <PersonAvatar avatar={avatar} userId={userId} name={mine ? undefined : name} size={32} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm }}>
          <Text style={[type.caption, { color: t.text, fontWeight: '700' }]}>
            {mine ? 'You' : name}
          </Text>
          <Text style={[type.caption, { color: t.textMuted }]}>{when}</Text>
          <View style={{ flex: 1 }} />
          {mine ? (
            // Delete, never edit: a message somebody has already read, silently
            // changed afterwards, is worse than one that visibly went away.
            <Pressable accessibilityRole="button" accessibilityLabel="Delete this message" onPress={onDelete} hitSlop={8}>
              <Text style={[type.caption, { color: t.textMuted, textDecorationLine: 'underline' }]}>
                Delete
              </Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={[type.body, { color: t.text }]} selectable>
          {body}
        </Text>
      </View>
    </View>
  );
}

// ----------------------------------------------------------------- shared --

/** The scrolling column the two set panes live in. */
function Pane({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ alignItems: 'center', padding: space.lg }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: space.md }}>{children}</View>
    </ScrollView>
  );
}

/**
 * Migration 0021 has not been applied.
 *
 * Says what is true — nothing is missing from the account — rather than showing
 * an empty list, which would read as "nobody has shared anything" and send
 * somebody looking for a bug that is not there. Same words as the notebook's.
 */
function NotSwitchedOn() {
  return (
    <Card>
      <Body>Sharing isn&apos;t switched on yet.</Body>
      <Body muted>
        Nothing is missing from your account — this part of the app just needs to be set up.
        Everything else works as normal.
      </Body>
    </Card>
  );
}
