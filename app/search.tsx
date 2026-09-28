import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Label, LoadingState, Notice, Rows } from '../src/ui/components';
import { PersonAvatar } from '../src/ui/avatar';
import { PersonRow, RowButton } from '../src/ui/people';
import { SetRow } from '../src/ui/profile-header';
import { Icon } from '../src/ui/glyphs';
import { clearRecent, loadRecent, rememberSearch } from '../src/ui/recent-searches';
import { CONTENT_MAX_WIDTH, INPUT_FONT_SIZE, NO_FOCUS_RING, radius, space, TOUCH_TARGET, type, useTheme } from '../src/ui/theme';
import { acceptFriendRequest, listBlocked, listFriendLinks, searchPeople, sendFriendRequest } from '../src/data/social';
import { searchPosts, searchSets } from '../src/data/search';
import { authorName } from '../src/core/community';
import { agoShort } from '../src/core/posts';
import { friendState, personName, searchTerm, type FriendState } from '../src/core/social';
import { useSessionStore } from '../src/data/session';

/**
 * Search (NOTES §59, the owner's picture): one box at the top of a screen of
 * its own, with Cancel beside it — people, shared sets and posts.
 *
 * It was a "Find people" box halfway down Profile; the owner named it as the
 * thing the redesign is for: *"the search in profile is at the bottom."* Now
 * it is the search icon at the top of Profile and Community, and it finds
 * more than people.
 *
 * Every result is read through the view that already decides who sees what —
 * `search_people` over `public_profiles`, `public_sets`, `feed_posts` — so a
 * search finds exactly what the reader could otherwise reach, never more.
 * Recent searches are kept on this phone only (src/ui/recent-searches.ts).
 */

/** Waits this long after the last key before searching, so typing "maria" is one request, not five. */
const SEARCH_DELAY_MS = 250;

export default function Search() {
  const t = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const me = useSessionStore((s) => s.session?.user.id ?? '');

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => setRecent(loadRecent(me)), [me]);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const term = searchTerm(debounced);
  const people = useQuery({ queryKey: ['people-search', term], queryFn: () => searchPeople(term ?? ''), enabled: term !== null });
  const sets = useQuery({ queryKey: ['set-search', term], queryFn: () => searchSets(term ?? ''), enabled: term !== null });
  const posts = useQuery({ queryKey: ['post-search', term], queryFn: () => searchPosts(term ?? ''), enabled: term !== null });
  const links = useQuery({ queryKey: ['friend-links'], queryFn: () => listFriendLinks() });
  const blocked = useQuery({ queryKey: ['blocked'], queryFn: () => listBlocked() });
  const blockedIds = useMemo(() => new Set((blocked.data ?? []).map((b) => b.person_id)), [blocked.data]);

  const refreshPeople = async () => {
    await queryClient.invalidateQueries({ queryKey: ['friend-links'] });
    await queryClient.invalidateQueries({ queryKey: ['people-search'] });
  };
  const add = useMutation({ mutationFn: (id: string) => sendFriendRequest(id), onSettled: refreshPeople });
  const accept = useMutation({ mutationFn: (id: string) => acceptFriendRequest(id), onSettled: refreshPeople });
  const failed = [add, accept].find((m) => m.isError)?.error as Error | undefined;

  const remember = () => {
    if (term) setRecent(rememberSearch(me, query));
  };
  const go = (path: Parameters<typeof router.push>[0]) => {
    remember();
    router.push(path);
  };
  const cancel = () => {
    if (navigation.canGoBack()) router.back();
    else router.replace('/profile');
  };

  const searching = term !== null && (people.isLoading || sets.isLoading || posts.isLoading);
  const nothing =
    term !== null &&
    !searching &&
    (people.data ?? []).length === 0 &&
    (sets.data ?? []).length === 0 &&
    (posts.data ?? []).length === 0;
  const now = Date.now();

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top + space.sm, alignItems: 'center' }}>
      <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH + 2 * space.lg, paddingHorizontal: space.lg, flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <View
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              minHeight: TOUCH_TARGET,
              paddingHorizontal: space.md,
              borderRadius: radius.pill,
              backgroundColor: t.card,
              borderWidth: 1,
              borderColor: t.accent,
            }}
          >
            <Icon name="search" color={t.textMuted} size={20} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search people, sets and posts"
              placeholderTextColor={t.textMuted}
              accessibilityLabel="Search people, sets and posts"
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={remember}
              // The pill's accent edge is the focus mark.
              style={[{ flex: 1, minHeight: TOUCH_TARGET, color: t.text, fontSize: INPUT_FONT_SIZE }, NO_FOCUS_RING]}
            />
            {query ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Clear the search" onPress={() => setQuery('')} hitSlop={10}>
                <Icon name="close" color={t.textMuted} size={18} />
              </Pressable>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={cancel}
            hitSlop={8}
            style={{ minHeight: TOUCH_TARGET, justifyContent: 'center' }}
          >
            <Text style={[type.body, { color: t.text }]}>Cancel</Text>
          </Pressable>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingVertical: space.lg, gap: space.lg, paddingBottom: insets.bottom + space.xl }}
          keyboardShouldPersistTaps="handled"
        >
          {term === null ? (
            query.trim().length > 0 ? (
              <Body muted>Type at least two letters.</Body>
            ) : recent.length > 0 ? (
              <View style={{ gap: space.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Label>Recent</Label>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Clear recent searches"
                    onPress={() => {
                      clearRecent(me);
                      setRecent([]);
                    }}
                    hitSlop={10}
                  >
                    <Text style={[type.caption, { color: t.accent, fontWeight: '600' }]}>Clear</Text>
                  </Pressable>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                  {recent.map((r) => (
                    <Pressable
                      key={r}
                      accessibilityRole="button"
                      accessibilityLabel={`Search again for ${r}`}
                      onPress={() => setQuery(r)}
                      style={({ pressed }) => ({
                        minHeight: 36,
                        justifyContent: 'center',
                        paddingHorizontal: space.md,
                        borderRadius: radius.pill,
                        borderWidth: 1,
                        borderColor: t.border,
                        backgroundColor: pressed ? t.card : 'transparent',
                      })}
                    >
                      <Text style={[type.label, { color: t.text }]}>{r}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : (
              <Body muted>Find people by their name or @username, shared sets by their title, and posts by their words.</Body>
            )
          ) : null}

          {searching ? <LoadingState what="Looking…" /> : null}
          {failed ? <Notice tone="error">{failed.message}</Notice> : null}
          {nothing ? <Body muted>{`Nothing found for "${term}".`}</Body> : null}

          {term !== null && (people.data ?? []).length > 0 ? (
            <View style={{ gap: space.xs }}>
              <Label>People</Label>
              <Rows>
                {(people.data ?? []).map((p) => {
                  const state = friendState(me, p.id, links.data ?? [], blockedIds);
                  return (
                    <PersonRow
                      key={p.id}
                      id={p.id}
                      name={p.display_name}
                      username={p.username}
                      avatar={p.avatar}
                      detail={stateLabel(state)}
                      onPress={() => go(`/person/${p.id}`)}
                    >
                      {state === 'none' ? (
                        <RowButton label="Add friend" primary busy={add.isPending && add.variables === p.id} onPress={() => add.mutate(p.id)} />
                      ) : state === 'received' ? (
                        <RowButton label="Accept" primary busy={accept.isPending && accept.variables === p.id} onPress={() => accept.mutate(p.id)} />
                      ) : state === 'friends' ? (
                        <RowButton label="Friends" onPress={() => go(`/person/${p.id}`)} />
                      ) : state === 'sent' ? (
                        <RowButton label="Requested" onPress={() => go(`/person/${p.id}`)} />
                      ) : null}
                    </PersonRow>
                  );
                })}
              </Rows>
            </View>
          ) : null}

          {term !== null && (sets.data ?? []).length > 0 ? (
            <View style={{ gap: space.xs }}>
              <Label>Sets</Label>
              <Rows>
                {(sets.data ?? []).map((s) => (
                  <SetRow
                    key={s.id}
                    title={s.title}
                    cards={s.cards}
                    stars={s.stars}
                    byline={s.owner_id === me ? 'Yours' : `by ${authorName(s.owner_name)}`}
                    onPress={() => go(`/set/${s.id}`)}
                  />
                ))}
              </Rows>
            </View>
          ) : null}

          {term !== null && (posts.data ?? []).length > 0 ? (
            <View style={{ gap: space.xs }}>
              <Label>Posts</Label>
              <Rows>
                {(posts.data ?? []).map((p) => {
                  const name = personName({ name: p.author_name, username: p.author_username });
                  return (
                    <Pressable
                      key={p.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Post by ${name}: ${p.body.slice(0, 100)}`}
                      onPress={() => go(`/post/${p.id}`)}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        gap: space.md,
                        paddingVertical: space.sm,
                        opacity: pressed ? 0.7 : 1,
                      })}
                    >
                      <PersonAvatar avatar={p.author_avatar} userId={p.author_id} name={name} size={36} />
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={[type.caption, { color: t.textMuted }]} numberOfLines={1}>
                          <Text style={{ fontWeight: '700', color: t.text }}>{name}</Text>
                          {`  ${agoShort(Date.parse(p.created_at), now)}`}
                        </Text>
                        <Text style={[type.body, { color: t.text }]} numberOfLines={2}>
                          {p.body}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </Rows>
            </View>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

/** What to say under a name in the results — also what a screen reader hears. */
function stateLabel(state: FriendState): string | undefined {
  switch (state) {
    case 'friends':
      return 'Friends';
    case 'sent':
      return 'Request sent';
    case 'received':
      return 'Wants to be friends';
    case 'blocked':
      return 'Blocked';
    default:
      return undefined;
  }
}
