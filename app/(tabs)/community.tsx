import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, LoadingState, Notice, TopBar } from '../../src/ui/components';
import { StatePanel } from '../../src/ui/states';
import { Segment, UnderlineTabs } from '../../src/ui/segment';
import { MyAvatar, PersonAvatar } from '../../src/ui/avatar';
import { PostList } from '../../src/ui/post';
import { InboxList } from '../../src/ui/inbox';
import { Icon } from '../../src/ui/glyphs';
import { PostsUnavailableError, listFeed } from '../../src/data/posts';
import { joinPages, nextCursor, type FeedCursor } from '../../src/core/posts';
import { CONTENT_MAX_WIDTH, radius, space, TOUCH_TARGET, type, useTheme } from '../../src/ui/theme';
import {
  authorName,
  browseOrder,
  rankSets,
  starLabel,
  canStar,
  type PublicSet,
} from '../../src/core/community';
import {
  CommunityUnavailableError,
  listPublicSets,
  myStars,
  star,
  unstar,
} from '../../src/data/community';
import { unreadMessages } from '../../src/data/messages';
import { badgeLabel, INBOX_POLL_MS } from '../../src/core/messages';
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
 * There were no profiles to visit when this was written: five people who
 * already knew each other did not need a social network. That changed with
 * NOTES §51, when the owner asked for friends and for the app to be ready for
 * people who do NOT know each other — so a name or a face here now opens that
 * person's page, and somebody else's message can be reported or its sender
 * blocked. Both were the precondition; "every one of those absences is a thing
 * that would need moderating" is exactly why they arrived first.
 *
 * ## Nothing here is the study path
 *
 * Tapping a shared set opens the ordinary set screen, which reads it through
 * `readableSet` and knows it is not yours. Studying it is studying it — the
 * same decks, the same schedule, your own answers. This screen only finds it.
 */

/**
 * Feed, Sets, Chat (NOTES §52, the owner's choice). The feed came first and
 * Top sets folded into Sets as a Newest / Top switch, so the row stayed at three
 * — four at 393px is where the labels start to crowd.
 */
type Pane = 'feed' | 'sets' | 'chat';

const PANES = [
  { key: 'feed' as const, label: 'Feed' },
  { key: 'sets' as const, label: 'Sets' },
  { key: 'chat' as const, label: 'Chat' },
];

const SET_ORDERS = [
  { key: 'new' as const, label: 'Newest' },
  { key: 'top' as const, label: 'Top' },
];


export default function Community() {
  const t = useTheme();
  const router = useRouter();
  const [pane, setPane] = useState<Pane>('feed');
  const [composing, setComposing] = useState(false);
  const signedIn = useSessionStore((s) => !!s.session);
  // The same count as the tab's badge — one query key, one number.
  const { data: unread = 0 } = useQuery({
    queryKey: ['dm-unread'],
    queryFn: () => unreadMessages(),
    refetchInterval: INBOX_POLL_MS,
    enabled: signedIn,
  });

  return (
    // Not `Screen`: the chat needs a bounded scroll area with the box to type in
    // pinned under it, and `Screen` is one ScrollView around everything — the
    // composer would scroll away with the messages. TabSlot gives this flex:1,
    // which is what bounds the pane below (NOTES §33).
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.lg }}>
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: space.sm }}>
          {/* The paper plane goes to your messages, with how many are new —
              where the owner's picture and every feed put it. */}
          {/* On Chat itself, the pencil instead: a new message or a new group
              (NOTES §58) — the owner's picture. */}
          <TopBar
            title="Community"
            brand
            actions={[
              { icon: 'search', label: 'Search', onPress: () => router.push('/search') },
              pane === 'chat'
                ? { icon: 'compose', label: 'New message', onPress: () => setComposing(true) }
                : { icon: 'send', label: 'Messages', badge: badgeLabel(unread), onPress: () => setPane('chat') },
            ]}
          />
          <UnderlineTabs value={pane} options={PANES} onChange={setPane} />
        </View>
      </View>

      {pane === 'chat' ? (
        // The chat list lives in src/ui/inbox.tsx since NOTES §74, because a
        // wide window draws it beside an open chat too.
        <Pane>
          <InboxList composing={composing} onCloseCompose={() => setComposing(false)} />
        </Pane>
      ) : pane === 'feed' ? (
        <FeedPane />
      ) : (
        <SetsPane />
      )}
    </View>
  );
}

// ------------------------------------------------------------------- feed --

/**
 * Friends' posts and everyone's public ones, newest first (NOTES §52).
 *
 * Twenty at a time, the next twenty asked for as the end comes into view — with
 * a button as well, because a scroll event is the kind of thing that silently
 * stops firing, and "the feed just ends" is indistinguishable from "that was
 * everything".
 */
function FeedPane() {
  const t = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const myId = useSessionStore((s) => s.session?.user.id ?? '');

  const feed = useInfiniteQuery({
    queryKey: ['feed'],
    queryFn: ({ pageParam }) => listFeed(pageParam),
    initialPageParam: null as FeedCursor | null,
    getNextPageParam: (last) => nextCursor(last),
    retry: (count, err) => !(err instanceof PostsUnavailableError) && count < 1,
  });
  const posts = useMemo(() => joinPages(feed.data?.pages ?? []), [feed.data]);

  const more = () => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ alignItems: 'center', padding: space.lg }}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={200}
      onScroll={({ nativeEvent: e }) => {
        if (e.layoutMeasurement.height + e.contentOffset.y >= e.contentSize.height - 600) more();
      }}
    >
      <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        {/* The way in to posting, where every feed puts it. Not a filled
            Button: a feed is for reading first. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Write a post"
          onPress={() => router.push('/post/new')}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, paddingBottom: space.md })}
        >
          <ComposePrompt />
        </Pressable>
        <View style={{ height: 1, backgroundColor: t.border, opacity: 0.6 }} />

        {feed.isLoading || feed.error || (feed.data && posts.length === 0) ? (
          <View style={{ gap: space.md, paddingTop: space.lg }}>
            {feed.isLoading ? <LoadingState /> : null}
            {feed.error instanceof PostsUnavailableError ? <PostsNotSwitchedOn /> : null}
            {feed.error && !(feed.error instanceof PostsUnavailableError) ? (
              <Notice tone="error">Couldn&apos;t load the feed. Try again in a moment.</Notice>
            ) : null}
            {feed.data && posts.length === 0 ? (
              <StatePanel
                kind="empty"
                title="Nothing here yet"
                detail="Write the first post, or add friends from your Profile to see theirs."
              />
            ) : null}
          </View>
        ) : null}

        <PostList
          posts={posts}
          myId={myId}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ['feed'] })}
        />

        <View style={{ paddingTop: space.sm }}>
          {feed.hasNextPage ? (
            <Button
              label="Show older posts"
              variant="secondary"
              onPress={more}
              busy={feed.isFetchingNextPage}
            />
          ) : posts.length > 0 ? (
            <Body muted>That&apos;s everything for now.</Body>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}

/**
 * Your picture, a box that looks like the place to type, and a photo icon —
 * the owner's picture. All of it opens the composer; the photo is chosen
 * there, since a browser only opens its file picker from a tap on the page
 * that asks.
 */
function ComposePrompt() {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <MyAvatar size={40} />
      <View
        style={{
          flex: 1,
          minHeight: TOUCH_TARGET,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingLeft: space.lg,
          paddingRight: space.md,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.card,
        }}
      >
        <Text style={[type.body, { color: t.textMuted, flex: 1 }]} numberOfLines={1}>
          Share something…
        </Text>
        <Icon name="photo" color={t.textMuted} size={22} />
      </View>
    </View>
  );
}

/** Migration 0027 has not been applied. Same words as the other two. */
function PostsNotSwitchedOn() {
  return (
    <Card>
      <Body>Posts aren&apos;t switched on yet.</Body>
      <Body muted>
        Nothing is missing from your account — this part of the app just needs to be set up. Everything
        else works as normal.
      </Body>
    </Card>
  );
}

// ------------------------------------------------------------ shared sets --

function SetsPane() {
  const router = useRouter();
  const [order, setOrder] = useState<'new' | 'top'>('new');
  const ranked = order === 'top';
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

  // Newest or Top, above whichever list is showing — including an empty one,
  // or there would be no way back from "No stars yet".
  const orderSwitch = <Segment value={order} options={SET_ORDERS} onChange={setOrder} role="radio" />;

  if (isLoading) return <Pane>{orderSwitch}<LoadingState /></Pane>;
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
        {orderSwitch}
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
      {orderSwitch}
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
          onOpenOwner={() => router.push(`/person/${set.owner_id}`)}
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
  onOpenOwner,
  onToggleStar,
}: {
  set: PublicSet;
  rank?: number;
  starred: boolean;
  mine: boolean;
  canStar: boolean;
  busy: boolean;
  onOpen: () => void;
  onOpenOwner: () => void;
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

      {/* Their face opens their page (NOTES §51); the title opens the set. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${authorName(set.owner_name)}'s profile`}
        onPress={onOpenOwner}
        hitSlop={6}
      >
        <PersonAvatar
          avatar={set.owner_avatar}
          userId={set.owner_id}
          name={authorName(set.owner_name)}
          size={32}
        />
      </Pressable>

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
      <Icon name="star" color={on ? t.accent : t.textMuted} size={20} filled={on} />
      <Text style={[type.caption, { color: on ? t.accent : t.textMuted }]}>{count}</Text>
    </Pressable>
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
