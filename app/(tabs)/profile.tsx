import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Body,
  Button,
  Card,
  EmptyState,
  Field,
  Label,
  LoadingState,
  Notice,
  Rows,
  Screen,
  TopBar,
} from '../../src/ui/components';
import { Avatar, PersonAvatar } from '../../src/ui/avatar';
import { TextLink } from '../../src/ui/legal';
import { PersonRow, RowButton } from '../../src/ui/people';
import { Sheet, SheetTitle } from '../../src/ui/sheet';
import { UnderlineTabs } from '../../src/ui/segment';
import { ProfileHeader, SetRow, StatsRow } from '../../src/ui/profile-header';
import { PostGrid } from '../../src/ui/post-grid';
import { SavedPosts } from '../../src/ui/saved';
import { GLYPH, Icon } from '../../src/ui/glyphs';
import { shareLink } from '../../src/ui/share';
import { space, TOUCH_TARGET, type, useTheme } from '../../src/ui/theme';
import { fetchProfile } from '../../src/data/profile';
import { getAppSnapshot } from '../../src/data/nomi';
import { countPosts, listFeed, PostsUnavailableError } from '../../src/data/posts';
import { listPublicSets } from '../../src/data/community';
import {
  acceptFriendRequest,
  fetchMyBio,
  fetchMyUsername,
  listBlocked,
  listFriendLinks,
  removeFriendLink,
  saveUsername,
  SocialUnavailableError,
  unblockPerson,
} from '../../src/data/social';
import { atUsername, personName, splitFriends, suggestUsername, USERNAME_MAX } from '../../src/core/social';
import { joinPages, nextCursor, type FeedCursor } from '../../src/core/posts';
import { browseOrder } from '../../src/core/community';
import { countLabel } from '../../src/core/profile';
import { useSessionStore } from '../../src/data/session';
import { isModerator, listReportQueue } from '../../src/data/moderation';

/**
 * Profile — who you are to everybody else (NOTES §51; redrawn in §59 from the
 * owner's picture).
 *
 * The tab that was Settings (the owner: *"having 6 buttons is too much"*).
 * Now shaped like every social app's own profile: your @username at the top
 * with search and Settings beside it; your picture, name and bio; your friends,
 * posts and streak as numbers; Edit profile and Share profile; the friend
 * requests waiting for you as one line to open; and what is yours in four tabs
 * — Posts, Sets, Friends, Saved.
 *
 * ## Where everything went
 *
 * Finding people was a box halfway down this page — the owner's own example of
 * what the redesign fixes: *"the search in profile is at the bottom."* It is
 * the search at the top now (`app/search.tsx`), for people, sets and posts.
 * Changing your username is in Edit profile; picking one for the first time
 * stays here, because nobody can find you without it. Requests you sent and
 * the people you blocked are under Friends; Saved, which had a bookmark in
 * the top bar for a step, is a tab (§57's promise).
 *
 * The streak here is your own — only you see this page this way. Somebody
 * else's page never shows theirs (the Privacy Policy).
 */

type Tab = 'posts' | 'sets' | 'friends' | 'saved';
const TABS = [
  { key: 'posts' as const, label: 'Posts' },
  { key: 'sets' as const, label: 'Sets' },
  { key: 'friends' as const, label: 'Friends' },
  { key: 'saved' as const, label: 'Saved' },
];

/** How long "Link copied" stays under Share profile. */
const COPIED_MS = 2500;

function retryUnlessOff(count: number, err: unknown): boolean {
  return !(err instanceof SocialUnavailableError) && count < 1;
}

export default function Profile() {
  const t = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const userId = useSessionStore((s) => s.session?.user.id) ?? '';
  const [tab, setTab] = useState<Tab>('posts');

  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const username = useQuery({ queryKey: ['my-username'], queryFn: () => fetchMyUsername(), retry: retryUnlessOff });
  const bio = useQuery({ queryKey: ['my-bio'], queryFn: () => fetchMyBio(), retry: false });
  const links = useQuery({ queryKey: ['friend-links'], queryFn: () => listFriendLinks(), retry: retryUnlessOff });
  const blocked = useQuery({ queryKey: ['blocked'], queryFn: () => listBlocked(), retry: retryUnlessOff });
  const snapshot = useQuery({ queryKey: ['nomi-brain'], queryFn: () => getAppSnapshot() });
  const postCount = useQuery({ queryKey: ['post-count', userId], queryFn: () => countPosts(userId), enabled: !!userId });
  const sets = useQuery({ queryKey: ['public-sets'], queryFn: () => listPublicSets() });
  const posts = useInfiniteQuery({
    queryKey: ['person-posts', userId],
    queryFn: ({ pageParam }) => listFeed(pageParam, userId),
    initialPageParam: null as FeedCursor | null,
    getNextPageParam: (last) => nextCursor(last),
    enabled: !!userId,
    retry: (count, err) => !(err instanceof PostsUnavailableError) && count < 1,
  });
  const myPosts = useMemo(() => joinPages(posts.data?.pages ?? []), [posts.data]);
  const mySets = useMemo(
    () => browseOrder((sets.data ?? []).filter((s) => s.owner_id === userId)),
    [sets.data, userId],
  );

  const off = username.error instanceof SocialUnavailableError || links.error instanceof SocialUnavailableError;

  // The moderator's way in to the reports (NOTES §55) — nobody else sees it.
  const moderator = useQuery({ queryKey: ['is-moderator'], queryFn: () => isModerator() });
  const reports = useQuery({
    queryKey: ['report-queue'],
    queryFn: () => listReportQueue(),
    enabled: moderator.data === true,
  });

  // --- a username, the first time: nobody can find you without one ---
  const [draft, setDraft] = useState<string | null>(null);
  const [usernameSaved, setUsernameSaved] = useState(false);
  const saveName = useMutation({
    mutationFn: (raw: string) => saveUsername(raw),
    onSuccess: async () => {
      setDraft(null);
      setUsernameSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['my-username'] });
    },
  });
  const suggestion = suggestUsername(profile?.display_name);

  const groups = useMemo(() => splitFriends(links.data ?? []), [links.data]);
  const refreshPeople = async () => {
    await queryClient.invalidateQueries({ queryKey: ['friend-links'] });
    await queryClient.invalidateQueries({ queryKey: ['people-search'] });
  };
  const accept = useMutation({ mutationFn: (personId: string) => acceptFriendRequest(personId), onSettled: refreshPeople });
  const remove = useMutation({ mutationFn: (linkId: string) => removeFriendLink(linkId), onSettled: refreshPeople });
  const unblock = useMutation({
    mutationFn: (personId: string) => unblockPerson(personId),
    // Everything: an unblock brings a person back into the chat, the shared
    // sets and search at once.
    onSettled: () => queryClient.invalidateQueries(),
  });
  const actionError = [accept, remove, unblock].find((m) => m.isError)?.error as Error | undefined;

  const [requestsOpen, setRequestsOpen] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);
  useEffect(() => {
    if (!shareNote) return;
    const timer = setTimeout(() => setShareNote(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [shareNote]);

  const handle = atUsername(username.data);
  const name = profile?.display_name?.trim() || (username.data ?? 'No name yet');
  const open = (id: string) => router.push(`/person/${id}`);

  const share = async () => {
    if (!username.data) {
      setShareNote('Pick a username first — your link is made from it.');
      return;
    }
    const outcome = await shareLink(`${name} on Nomi`, `/u/${username.data}`);
    if (outcome === 'copied') setShareNote('Link copied.');
    if (outcome === 'failed') setShareNote("Couldn't share that just now.");
  };

  return (
    <Screen>
      {/* Your @username where the picture has it, with search and Settings
          beside it (NOTES §56.3, §59). */}
      <TopBar
        title={handle ?? 'Profile'}
        actions={[
          { icon: 'search', label: 'Search', onPress: () => router.push('/search') },
          { icon: 'settings', label: 'Settings', onPress: () => router.push('/settings') },
        ]}
      />

      {moderator.data ? (
        <Button
          label={reports.data && reports.data.length > 0 ? `Reports to review (${reports.data.length})` : 'Reports to review'}
          variant="outline"
          onPress={() => router.push('/moderation')}
        />
      ) : null}

      <ProfileHeader
        picture={<Avatar value={profile?.avatar} userId={userId} size={88} />}
        name={name}
        handle={handle}
        bio={bio.data}
      />

      <StatsRow
        stats={[
          { value: groups.friends.length, label: countLabel(groups.friends.length, 'Friend', 'Friends') },
          { value: postCount.data ?? 0, label: countLabel(postCount.data ?? 0, 'Post', 'Posts') },
          { value: snapshot.data?.streak ?? 0, label: 'Streak', icon: 'streak', iconColor: t.chart.tricky },
        ]}
      />

      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button label="Edit profile" variant="secondary" onPress={() => router.push('/edit-profile')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Share profile" variant="secondary" onPress={() => void share()} />
        </View>
      </View>
      {shareNote ? <Body muted>{shareNote}</Body> : null}

      {off ? (
        <NotSwitchedOn />
      ) : (
        <>
          {/* Open while there is no username yet — nobody can find you
              without one. Changing it later is in Edit profile. */}
          {username.isSuccess && !username.data ? (
            <Card>
              <Body>Pick a username</Body>
              <Field
                label="Username"
                value={draft ?? ''}
                onChangeText={(v) => {
                  setDraft(v);
                  setUsernameSaved(false);
                  saveName.reset();
                }}
                placeholder={suggestion ?? 'yourname'}
                maxLength={USERNAME_MAX + 1}
                onSubmitEditing={() => saveName.mutate(draft ?? '')}
              />
              <Body muted>Friends find you by this. Letters, numbers and _, starting with a letter.</Body>
              <Button
                label="Save username"
                onPress={() => saveName.mutate(draft ?? '')}
                busy={saveName.isPending}
                disabled={!draft?.trim()}
              />
              {saveName.isError ? <Notice tone="error">{(saveName.error as Error).message}</Notice> : null}
            </Card>
          ) : null}
          {usernameSaved ? <Notice tone="ok">Saved.</Notice> : null}

          {/* The requests waiting for you, as one line to open — the picture. */}
          {groups.received.length > 0 ? (
            <RequestsBanner
              count={groups.received.length}
              first={groups.received.slice(0, 2)}
              onPress={() => setRequestsOpen(true)}
            />
          ) : null}
          {actionError ? <Notice tone="error">{actionError.message}</Notice> : null}

          <UnderlineTabs value={tab} options={TABS} onChange={setTab} />

          {tab === 'posts' ? (
            <View style={{ gap: space.md }}>
              {posts.isLoading ? <LoadingState /> : null}
              {posts.data && myPosts.length === 0 ? (
                <EmptyState title="You haven't posted yet" detail="Share a win, a photo or a set from Community." />
              ) : null}
              <PostGrid posts={myPosts} />
              {posts.hasNextPage ? (
                <Button
                  label="Show older posts"
                  variant="secondary"
                  onPress={() => void posts.fetchNextPage()}
                  busy={posts.isFetchingNextPage}
                />
              ) : null}
            </View>
          ) : tab === 'sets' ? (
            <View style={{ gap: space.sm }}>
              <Body muted>The sets you share — everyone signed in can find and study them.</Body>
              {sets.isLoading ? <LoadingState /> : null}
              {sets.data && mySets.length === 0 ? (
                <EmptyState
                  title="You haven't shared a set yet"
                  detail={`Open one of your sets and choose Share with everyone from its ${GLYPH.more}.`}
                />
              ) : null}
              <Rows>
                {mySets.map((s) => (
                  <SetRow key={s.id} title={s.title} cards={s.cards} stars={s.stars} onPress={() => router.push(`/set/${s.id}`)} />
                ))}
              </Rows>
            </View>
          ) : tab === 'friends' ? (
            <FriendsTab
              friends={groups.friends}
              sent={groups.sent}
              blocked={blocked.data ?? []}
              loading={links.isLoading}
              removing={remove.isPending ? (remove.variables ?? null) : null}
              unblocking={unblock.isPending ? (unblock.variables ?? null) : null}
              onOpen={open}
              onCancel={(linkId) => remove.mutate(linkId)}
              onUnblock={(personId) => unblock.mutate(personId)}
              onRules={() => router.push('/rules')}
            />
          ) : (
            <SavedPosts myId={userId} />
          )}
        </>
      )}

      {requestsOpen ? (
        <Sheet onClose={() => setRequestsOpen(false)}>
          <SheetTitle>Friend requests</SheetTitle>
          {groups.received.length === 0 ? <Body muted>Nobody is waiting for an answer.</Body> : null}
          <Rows card>
            {groups.received.map((link) => (
              <PersonRow
                key={link.id}
                id={link.person_id}
                name={link.name}
                username={link.username}
                avatar={link.avatar}
                inset
                onPress={() => {
                  setRequestsOpen(false);
                  open(link.person_id);
                }}
              >
                <RowButton
                  label="Accept"
                  primary
                  busy={accept.isPending && accept.variables === link.person_id}
                  onPress={() => accept.mutate(link.person_id)}
                />
                <RowButton
                  label="Decline"
                  busy={remove.isPending && remove.variables === link.id}
                  onPress={() => remove.mutate(link.id)}
                />
              </PersonRow>
            ))}
          </Rows>
        </Sheet>
      ) : null}
    </Screen>
  );
}

/** "2 friend requests", with the first two faces overlapping, and a chevron. */
function RequestsBanner({
  count,
  first,
  onPress,
}: {
  count: number;
  first: readonly { person_id: string; name: string | null; username: string | null; avatar: string | null }[];
  onPress: () => void;
}) {
  const t = useTheme();
  const label = `${count} friend request${count === 1 ? '' : 's'}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${first.map((p) => personName(p)).join(', ')}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        minHeight: TOUCH_TARGET + space.sm,
        paddingHorizontal: space.md,
        borderRadius: 14,
        backgroundColor: t.card,
        borderWidth: 1,
        borderColor: t.border,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <View style={{ flexDirection: 'row' }}>
        {first.map((p, i) => (
          <View key={p.person_id} style={{ marginLeft: i === 0 ? 0 : -10, borderRadius: 16, borderWidth: 2, borderColor: t.card }}>
            <PersonAvatar avatar={p.avatar} userId={p.person_id} name={personName(p)} size={28} />
          </View>
        ))}
      </View>
      <Text style={[type.body, { color: t.text, flex: 1 }]}>{label}</Text>
      <Icon name="forward" color={t.textMuted} size={20} />
    </Pressable>
  );
}

/** Your friends; the requests you sent; the people you blocked; the rules. */
function FriendsTab({
  friends,
  sent,
  blocked,
  loading,
  removing,
  unblocking,
  onOpen,
  onCancel,
  onUnblock,
  onRules,
}: {
  friends: readonly { id: string; person_id: string; name: string | null; username: string | null; avatar: string | null }[];
  sent: readonly { id: string; person_id: string; name: string | null; username: string | null; avatar: string | null }[];
  blocked: readonly { person_id: string; name: string | null; username: string | null; avatar: string | null }[];
  loading: boolean;
  removing: string | null;
  unblocking: string | null;
  onOpen: (personId: string) => void;
  onCancel: (linkId: string) => void;
  onUnblock: (personId: string) => void;
  onRules: () => void;
}) {
  return (
    <View style={{ gap: space.md }}>
      <Body muted>Only you can see who your friends are.</Body>
      {loading ? <LoadingState /> : null}
      {!loading && friends.length === 0 ? (
        <EmptyState title="No friends yet" detail="Search for someone at the top, or tap a name in the chat to see their profile." />
      ) : null}
      <Rows>
        {friends.map((link) => (
          <PersonRow
            key={link.id}
            id={link.person_id}
            name={link.name}
            username={link.username}
            avatar={link.avatar}
            onPress={() => onOpen(link.person_id)}
          />
        ))}
      </Rows>

      {sent.length > 0 ? (
        <View style={{ gap: space.xs }}>
          <Label>Requests you sent</Label>
          <Rows>
            {sent.map((link) => (
              <PersonRow
                key={link.id}
                id={link.person_id}
                name={link.name}
                username={link.username}
                avatar={link.avatar}
                detail="Waiting for them"
                onPress={() => onOpen(link.person_id)}
              >
                <RowButton label="Cancel" busy={removing === link.id} onPress={() => onCancel(link.id)} />
              </PersonRow>
            ))}
          </Rows>
        </View>
      ) : null}

      {blocked.length > 0 ? (
        <View style={{ gap: space.xs }}>
          <Label>Blocked</Label>
          <Rows>
            {blocked.map((b) => (
              <PersonRow key={b.person_id} id={b.person_id} name={b.name} username={b.username} avatar={b.avatar}>
                <RowButton label="Unblock" busy={unblocking === b.person_id} onPress={() => onUnblock(b.person_id)} />
              </PersonRow>
            ))}
          </Rows>
        </View>
      ) : null}

      <TextLink label="Community rules" onPress={onRules} />
    </View>
  );
}

/**
 * Migration 0026 has not been applied.
 *
 * Says what is true — nothing is missing from the account — in the same words
 * as Community's, rather than an empty friends list that would read as "you
 * have no friends".
 */
function NotSwitchedOn() {
  return (
    <Card>
      <Body>Friends aren&apos;t switched on yet.</Body>
      <Body muted>
        Nothing is missing from your account — this part of the app just needs to be set up. Everything
        else works as normal.
      </Body>
    </Card>
  );
}
