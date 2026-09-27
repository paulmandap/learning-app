import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Body,
  Button,
  Card,
  EmptyState,
  Field,
  LoadingState,
  Notice,
  Screen,
  SectionRow,
  TitleRow,
} from '../../src/ui/components';
import { Avatar } from '../../src/ui/avatar';
import { TextLink } from '../../src/ui/legal';
import { PersonRow, RowButton } from '../../src/ui/people';
import { TabIcon } from '../../src/ui/glyphs';
import { TOUCH_TARGET, space, type, useTheme } from '../../src/ui/theme';
import { fetchProfile } from '../../src/data/profile';
import {
  acceptFriendRequest,
  fetchMyUsername,
  listBlocked,
  listFriendLinks,
  removeFriendLink,
  saveUsername,
  searchPeople,
  SocialUnavailableError,
  unblockPerson,
} from '../../src/data/social';
import {
  atUsername,
  friendCountLabel,
  friendState,
  searchTerm,
  splitFriends,
  suggestUsername,
  USERNAME_MAX,
  type FriendState,
} from '../../src/core/social';
import { useSessionStore } from '../../src/data/session';

/**
 * Profile — who you are to everybody else, and who your friends are (NOTES §51).
 *
 * The tab that was Settings. The owner, planning the social side of the app:
 * *"i already have 5 buttons which are Nomi, Notes, community, progress,
 * settings. one has to go if ever. because having 6 buttons is too much."* So
 * nothing went — Settings moved behind the control at the top right, the way a
 * phone's own social apps keep it, and this took its place. Five tabs still fit
 * at 393px (NOTES §46.4), and "Profile" is a shorter word than the one it replaced.
 *
 * ## What is here, in the order it is used
 *
 * You (your picture, your name, your @username); the requests waiting for you,
 * because somebody is waiting on an answer; finding people; your friends; the
 * requests you sent; the people you blocked. Settings — the key, reminders,
 * Delete my data — is one tap away and none of it is about other people.
 */

/** Waits this long after the last key before searching, so typing "maria" is one request, not five. */
const SEARCH_DELAY_MS = 250;

function retryUnlessOff(count: number, err: unknown): boolean {
  return !(err instanceof SocialUnavailableError) && count < 1;
}

export default function Profile() {
  const t = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const userId = useSessionStore((s) => s.session?.user.id) ?? '';

  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const username = useQuery({ queryKey: ['my-username'], queryFn: () => fetchMyUsername(), retry: retryUnlessOff });
  const links = useQuery({ queryKey: ['friend-links'], queryFn: () => listFriendLinks(), retry: retryUnlessOff });
  const blocked = useQuery({ queryKey: ['blocked'], queryFn: () => listBlocked(), retry: retryUnlessOff });

  const off =
    username.error instanceof SocialUnavailableError || links.error instanceof SocialUnavailableError;

  // --- your username ---
  const [draft, setDraft] = useState<string | null>(null);
  const [usernameSaved, setUsernameSaved] = useState(false);
  /**
   * Changing a username you already have. Folded away otherwise: photographed
   * at 393px, a field, a paragraph and a button for a name you chose once
   * pushed the requests waiting for you below the fold on every visit.
   */
  const [editingUsername, setEditingUsername] = useState(false);
  const saveName = useMutation({
    mutationFn: (raw: string) => saveUsername(raw),
    onSuccess: async () => {
      setDraft(null);
      setUsernameSaved(true);
      setEditingUsername(false);
      await queryClient.invalidateQueries({ queryKey: ['my-username'] });
    },
  });
  const suggestion = suggestUsername(profile?.display_name);

  // --- finding people ---
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const term = searchTerm(debounced);
  const results = useQuery({
    queryKey: ['people-search', term],
    queryFn: () => searchPeople(term ?? ''),
    enabled: term !== null && !off,
  });

  const groups = useMemo(() => splitFriends(links.data ?? []), [links.data]);
  const blockedIds = useMemo(() => new Set((blocked.data ?? []).map((b) => b.person_id)), [blocked.data]);

  const refreshPeople = async () => {
    await queryClient.invalidateQueries({ queryKey: ['friend-links'] });
    await queryClient.invalidateQueries({ queryKey: ['people-search'] });
  };

  const accept = useMutation({
    mutationFn: (personId: string) => acceptFriendRequest(personId),
    onSettled: refreshPeople,
  });
  const remove = useMutation({
    mutationFn: (linkId: string) => removeFriendLink(linkId),
    onSettled: refreshPeople,
  });
  const unblock = useMutation({
    mutationFn: (personId: string) => unblockPerson(personId),
    // Everything: an unblock brings a person back into the chat, the shared
    // sets and search at once.
    onSettled: () => queryClient.invalidateQueries(),
  });

  const actionError = [accept, remove, unblock].find((m) => m.isError)?.error as Error | undefined;
  const open = (id: string) => router.push(`/person/${id}`);

  return (
    <Screen>
      <TitleRow title="Profile" action={<SettingsButton onPress={() => router.push('/settings')} />} />

      {/* ------------------------------------------------------------ you -- */}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
          <Avatar value={profile?.avatar} userId={userId} size={72} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[type.title, { color: t.text }]} numberOfLines={2}>
              {profile?.display_name?.trim() || 'No name yet'}
            </Text>
            <Text style={[type.body, { color: t.textMuted }]}>
              {atUsername(username.data) ?? (off ? ' ' : 'No username yet')}
            </Text>
            {!off && links.data ? (
              <Text style={[type.caption, { color: t.textMuted }]}>{friendCountLabel(groups.friends.length)}</Text>
            ) : null}
          </View>
        </View>
        {username.data && !editingUsername ? (
          <TextLink
            label="Change username"
            onPress={() => {
              setEditingUsername(true);
              setUsernameSaved(false);
            }}
          />
        ) : null}
        {usernameSaved && !editingUsername ? <Notice tone="ok">Saved.</Notice> : null}
        <Button
          label="Change your name or picture"
          variant="secondary"
          onPress={() => router.push('/settings')}
        />
      </Card>

      {off ? (
        <NotSwitchedOn />
      ) : (
        <>
          {/* ------------------------------------------------ username -- */}
          {/* Open when there is none yet — you cannot be found without it —
              and when changing one. */}
          {!username.data || editingUsername ? (
            <Card>
              <Body>{username.data ? 'Change your username' : 'Pick a username'}</Body>
              <Field
                label="Username"
                value={draft ?? username.data ?? ''}
                onChangeText={(v) => {
                  setDraft(v);
                  setUsernameSaved(false);
                  saveName.reset();
                }}
                placeholder={suggestion ?? 'yourname'}
                maxLength={USERNAME_MAX + 1}
                onSubmitEditing={() => saveName.mutate(draft ?? username.data ?? '')}
              />
              <Body muted>
                Friends find you by this. Letters, numbers and _, starting with a letter.
              </Body>
              <Button
                label="Save username"
                onPress={() => saveName.mutate(draft ?? username.data ?? '')}
                busy={saveName.isPending}
                disabled={draft === null || draft.trim() === (username.data ?? '')}
              />
              {saveName.isError ? <Notice tone="error">{(saveName.error as Error).message}</Notice> : null}
              {editingUsername ? (
                <Button
                  label="Keep it"
                  variant="secondary"
                  onPress={() => {
                    setEditingUsername(false);
                    setDraft(null);
                    saveName.reset();
                  }}
                  disabled={saveName.isPending}
                />
              ) : null}
            </Card>
          ) : null}

          {actionError ? <Notice tone="error">{actionError.message}</Notice> : null}

          {/* -------------------------------------------------- requests -- */}
          {groups.received.length > 0 ? (
            <View style={{ gap: space.sm }}>
              <SectionRow title={`Friend requests (${groups.received.length})`} />
              {groups.received.map((link) => (
                <PersonRow
                  key={link.id}
                  id={link.person_id}
                  name={link.name}
                  username={link.username}
                  avatar={link.avatar}
                  // No "Wants to be friends" here: the heading says it, and
                  // beside two buttons it only cut the @username short.
                  onPress={() => open(link.person_id)}
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
            </View>
          ) : null}

          {/* ---------------------------------------------- find people -- */}
          <View style={{ gap: space.sm }}>
            <SectionRow title="Find people" />
            <Field
              label="Search"
              value={query}
              onChangeText={setQuery}
              placeholder="A name or @username"
            />
            {query.trim().length > 0 && searchTerm(query) === null ? (
              <Body muted>Type at least two letters.</Body>
            ) : null}
            {term !== null && results.isLoading ? <LoadingState what="Looking…" /> : null}
            {term !== null && results.isError ? (
              <Notice tone="error">Couldn&apos;t search just now. Try again in a moment.</Notice>
            ) : null}
            {term !== null && results.data && results.data.length === 0 ? (
              <Body muted>Nobody found by that name.</Body>
            ) : null}
            {(term !== null ? results.data ?? [] : []).map((person) => (
              <PersonRow
                key={person.id}
                id={person.id}
                name={person.display_name}
                username={person.username}
                avatar={person.avatar}
                detail={stateLabel(friendState(userId, person.id, links.data ?? [], blockedIds))}
                onPress={() => open(person.id)}
              />
            ))}
          </View>

          {/* -------------------------------------------------- friends -- */}
          <View style={{ gap: space.sm }}>
            <SectionRow title={groups.friends.length > 0 ? `Friends (${groups.friends.length})` : 'Friends'} />
            {links.isLoading ? <LoadingState /> : null}
            {links.data && groups.friends.length === 0 ? (
              <EmptyState
                title="No friends yet"
                detail="Search for someone above, or tap a name in the chat to see their profile."
              />
            ) : null}
            {groups.friends.map((link) => (
              <PersonRow
                key={link.id}
                id={link.person_id}
                name={link.name}
                username={link.username}
                avatar={link.avatar}
                onPress={() => open(link.person_id)}
              />
            ))}
          </View>

          {/* --------------------------------------------- sent requests -- */}
          {groups.sent.length > 0 ? (
            <View style={{ gap: space.sm }}>
              <SectionRow title="Requests you sent" />
              {groups.sent.map((link) => (
                <PersonRow
                  key={link.id}
                  id={link.person_id}
                  name={link.name}
                  username={link.username}
                  avatar={link.avatar}
                  detail="Waiting for them"
                  onPress={() => open(link.person_id)}
                >
                  <RowButton
                    label="Cancel"
                    busy={remove.isPending && remove.variables === link.id}
                    onPress={() => remove.mutate(link.id)}
                  />
                </PersonRow>
              ))}
            </View>
          ) : null}

          {/* -------------------------------------------------- blocked -- */}
          {(blocked.data ?? []).length > 0 ? (
            <View style={{ gap: space.sm }}>
              <SectionRow title="Blocked" />
              {(blocked.data ?? []).map((b) => (
                <PersonRow key={b.person_id} id={b.person_id} name={b.name} username={b.username} avatar={b.avatar}>
                  <RowButton
                    label="Unblock"
                    busy={unblock.isPending && unblock.variables === b.person_id}
                    onPress={() => unblock.mutate(b.person_id)}
                  />
                </PersonRow>
              ))}
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}

/** What to say under a name in the search results. */
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

/**
 * The way to Settings, top right.
 *
 * The same two sliders the Settings tab used to wear, so the thing somebody
 * looked for at the bottom of the screen yesterday is recognisable at the top
 * today. Drawn, not typed — the gear character is an emoji on some phones
 * (src/ui/glyphs.tsx).
 */
function SettingsButton({ onPress }: { onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Settings"
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        width: TOUCH_TARGET,
        height: TOUCH_TARGET,
        alignItems: 'flex-end',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <TabIcon name="settings" color={t.accent} ground={t.bg} />
    </Pressable>
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
