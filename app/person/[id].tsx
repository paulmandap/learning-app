import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Body,
  Button,
  Card,
  EmptyState,
  ListRow,
  LoadingState,
  Notice,
  Screen,
  SectionRow,
} from '../../src/ui/components';
import { StatePanel } from '../../src/ui/states';
import { OverflowMenu } from '../../src/ui/menu';
import { PersonAvatar } from '../../src/ui/avatar';
import { BlockSheet, ReportSheet } from '../../src/ui/people';
import { PostList } from '../../src/ui/post';
import { listFeed, PostsUnavailableError } from '../../src/data/posts';
import { startConversation } from '../../src/data/messages';
import { joinPages, nextCursor, type FeedCursor } from '../../src/core/posts';
import { space, type, useTheme } from '../../src/ui/theme';
import {
  acceptFriendRequest,
  getPerson,
  listBlocked,
  listFriendLinks,
  removeFriendLink,
  sendFriendRequest,
  SocialUnavailableError,
  unblockPerson,
} from '../../src/data/social';
import { listPublicSets } from '../../src/data/community';
import { atUsername, friendState, personName } from '../../src/core/social';
import { browseOrder, starLabel } from '../../src/core/community';
import { useSessionStore } from '../../src/data/session';

/**
 * Somebody's page (NOTES §51).
 *
 * Reached by tapping a name — in the chat, beside a shared set, in search, in
 * your friends. What it shows is what the Privacy Policy says anyone signed in
 * can see of a person: their name, their @username, the picture they are using,
 * and the sets they chose to share. NOT their friends, their streak or how they
 * are doing — none of that is anybody else's, and none of it is in the views.
 *
 * ## One screen for every relationship
 *
 * Stranger, asked, asking, friends, blocked, or yourself: the same page, with
 * the one thing you can do next as its button. Report and Block live in the ⋯,
 * where they are findable but never one careless tap from the page's main
 * button.
 */
export default function PersonPage() {
  const t = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const personId = String(id);
  const me = useSessionStore((s) => s.session?.user.id) ?? '';

  const person = useQuery({ queryKey: ['person', personId], queryFn: () => getPerson(personId) });
  const retry = (count: number, err: unknown) => !(err instanceof SocialUnavailableError) && count < 1;
  const links = useQuery({ queryKey: ['friend-links'], queryFn: () => listFriendLinks(), retry });
  const blocked = useQuery({ queryKey: ['blocked'], queryFn: () => listBlocked(), retry });
  const sets = useQuery({ queryKey: ['public-sets'], queryFn: () => listPublicSets() });
  // Their posts — the ones the rule in 0027 lets me see: everything they post
  // to everyone, and to friends when we are (NOTES §52).
  const posts = useInfiniteQuery({
    queryKey: ['person-posts', personId],
    queryFn: ({ pageParam }) => listFeed(pageParam, personId),
    initialPageParam: null as FeedCursor | null,
    getNextPageParam: (last) => nextCursor(last),
    retry: (count, err) => !(err instanceof PostsUnavailableError) && count < 1,
  });
  const theirPosts = useMemo(() => joinPages(posts.data?.pages ?? []), [posts.data]);

  const off = links.error instanceof SocialUnavailableError;
  const blockedIds = useMemo(() => new Set((blocked.data ?? []).map((b) => b.person_id)), [blocked.data]);
  const state = friendState(me, personId, links.data ?? [], blockedIds);
  const link = (links.data ?? []).find((l) => l.person_id === personId);
  const theirSets = useMemo(
    () => browseOrder((sets.data ?? []).filter((s) => s.owner_id === personId)),
    [sets.data, personId],
  );

  const [reporting, setReporting] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [confirmUnfriend, setConfirmUnfriend] = useState(false);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['friend-links'] });
    await queryClient.invalidateQueries({ queryKey: ['people-search'] });
  };
  const add = useMutation({ mutationFn: () => sendFriendRequest(personId), onSettled: refresh });
  const accept = useMutation({ mutationFn: () => acceptFriendRequest(personId), onSettled: refresh });
  const remove = useMutation({
    mutationFn: () => removeFriendLink(link?.id ?? ''),
    onSuccess: () => setConfirmUnfriend(false),
    onSettled: refresh,
  });
  const unblock = useMutation({
    mutationFn: () => unblockPerson(personId),
    onSettled: () => queryClient.invalidateQueries(),
  });
  // Friends can message each other (NOTES §53). Finds the conversation there
  // already is, or opens one.
  const message = useMutation({
    mutationFn: () => startConversation(personId),
    onSuccess: (conversationId) => router.push(`/messages/${conversationId}`),
  });
  const failed = [add, accept, remove, unblock, message].find((m) => m.isError)?.error as Error | undefined;

  if (person.isLoading) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '' }} />
        <LoadingState />
      </Screen>
    );
  }

  // Nobody by that id, OR somebody on the other side of a block from me — the
  // same answer on purpose. The app never tells anybody that they were blocked.
  if (!person.data) {
    return (
      <Screen centered>
        <Stack.Screen options={{ title: '' }} />
        <StatePanel
          kind="empty"
          title="We couldn't find this person"
          detail="They may have left Nomi."
          action={{ label: 'Back to your profile', onPress: () => router.replace('/profile') }}
        />
      </Screen>
    );
  }

  const who = person.data;
  const name = personName({ name: who.display_name, username: who.username });
  const handle = atUsername(who.username);

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: '',
          // Nothing to report or block about yourself, and an empty ⋯ is worse
          // than none (the set screen's rule).
          headerRight:
            state === 'self' || off
              ? undefined
              : () => (
                  <OverflowMenu
                    accessibilityLabel={`More about ${name}`}
                    items={[
                      { icon: 'report', label: `Report ${name}`, destructive: true, onPress: () => setReporting(true) },
                      state === 'blocked'
                        ? { icon: 'block', label: `Unblock ${name}`, onPress: () => unblock.mutate() }
                        : { icon: 'block', label: `Block ${name}`, destructive: true, onPress: () => setBlocking(true) },
                    ]}
                  />
                ),
        }}
      />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
        <PersonAvatar avatar={who.avatar} userId={who.id} name={name} size={88} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.display, { color: t.text }]} numberOfLines={2}>
            {name}
          </Text>
          {handle && handle !== name ? <Text style={[type.body, { color: t.textMuted }]}>{handle}</Text> : null}
        </View>
      </View>

      {failed ? <Notice tone="error">{failed.message}</Notice> : null}

      {/* The one thing to do next, for where you stand with them. */}
      {off ? null : state === 'self' ? (
        <Card>
          <Body>This is you — how other people see your page.</Body>
          <Button label="Go to your profile" variant="secondary" onPress={() => router.replace('/profile')} />
        </Card>
      ) : state === 'blocked' ? (
        <Card>
          <Body>You blocked {name}.</Body>
          <Body muted>You can&apos;t see each other&apos;s messages or shared sets, and they can&apos;t find you.</Body>
          <Button label={`Unblock ${name}`} variant="secondary" onPress={() => unblock.mutate()} busy={unblock.isPending} />
        </Card>
      ) : state === 'friends' ? (
        <Card>
          <Body>You&apos;re friends.</Body>
          <Button label={`Message ${name}`} variant="outline" onPress={() => message.mutate()} busy={message.isPending} />
          {confirmUnfriend ? (
            <>
              <Body muted>Unfriend {name}? They won&apos;t be told, and you can ask again later.</Body>
              <Button label="Unfriend" variant="danger" onPress={() => remove.mutate()} busy={remove.isPending} />
              <Button label="Stay friends" variant="secondary" onPress={() => setConfirmUnfriend(false)} />
            </>
          ) : (
            <Button label="Unfriend" variant="secondary" onPress={() => setConfirmUnfriend(true)} />
          )}
        </Card>
      ) : state === 'received' ? (
        <Card>
          <Body>{name} wants to be friends.</Body>
          <Button label="Accept" onPress={() => accept.mutate()} busy={accept.isPending} />
          <Button label="Decline" variant="secondary" onPress={() => remove.mutate()} disabled={accept.isPending} />
        </Card>
      ) : state === 'sent' ? (
        <Card>
          <Body>Friend request sent. It&apos;s up to them now.</Body>
          <Button label="Cancel request" variant="secondary" onPress={() => remove.mutate()} busy={remove.isPending} />
        </Card>
      ) : (
        <Button label="Add friend" onPress={() => add.mutate()} busy={add.isPending} />
      )}

      {/* What they chose to share. Nothing else of theirs is anybody's. */}
      {state !== 'blocked' ? (
        <View style={{ gap: space.sm }}>
          <SectionRow title="Shared sets" />
          {sets.isLoading ? <LoadingState /> : null}
          {sets.data && theirSets.length === 0 ? (
            <EmptyState title={state === 'self' ? "You haven't shared a set yet" : 'Nothing shared yet'} />
          ) : null}
          {theirSets.map((set) => (
            <ListRow
              key={set.id}
              title={set.title}
              meta={`${set.cards} card${set.cards === 1 ? '' : 's'} · ${starLabel(set.stars)}`}
              onPress={() => router.push(`/set/${set.id}`)}
            />
          ))}
        </View>
      ) : null}

      {/* Posts, after the sets: a page is who somebody is before what they said. */}
      {state !== 'blocked' && !(posts.error instanceof PostsUnavailableError) ? (
        <View style={{ gap: space.sm }}>
          <SectionRow title="Posts" />
          {posts.isLoading ? <LoadingState /> : null}
          {posts.data && theirPosts.length === 0 ? (
            <EmptyState
              title={state === 'self' ? "You haven't posted yet" : 'No posts to show'}
              detail={
                state === 'self' || state === 'friends'
                  ? undefined
                  : 'Posts for friends only show here once you are friends.'
              }
            />
          ) : null}
          <PostList
            posts={theirPosts}
            myId={me}
            onChanged={() => queryClient.invalidateQueries({ queryKey: ['person-posts', personId] })}
          />
          {posts.hasNextPage ? (
            <Button
              label="Show older posts"
              variant="secondary"
              onPress={() => void posts.fetchNextPage()}
              busy={posts.isFetchingNextPage}
            />
          ) : null}
        </View>
      ) : null}

      {reporting ? (
        <ReportSheet
          kind="person"
          targetId={personId}
          name={name}
          onBlock={
            state === 'blocked'
              ? undefined
              : () => {
                  setReporting(false);
                  setBlocking(true);
                }
          }
          onClose={() => setReporting(false)}
        />
      ) : null}
      {blocking ? <BlockSheet personId={personId} name={name} onClose={() => setBlocking(false)} /> : null}
    </Screen>
  );
}
