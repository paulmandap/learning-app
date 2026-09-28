import { useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Field, Label, LoadingState, Notice, Screen, TopBar } from '../../src/ui/components';
import { FriendPicker } from '../../src/ui/friend-picker';
import { listFriendLinks } from '../../src/data/social';
import { createGroup } from '../../src/data/groups';
import { splitFriends } from '../../src/core/social';
import { GROUP_MAX_PEOPLE, GROUP_TITLE_MAX, validateGroupTitle } from '../../src/core/groups';

/**
 * Make a group (NOTES §58): a name, and friends to put in it.
 *
 * Friends only — the database checks it again — and thirty people with you.
 * A screen of its own rather than a sheet: a list of friends to tick through
 * can be long, and a name to type wants the keyboard without a sheet fighting
 * it for the room.
 */
export default function NewGroup() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const links = useQuery({ queryKey: ['friend-links'], queryFn: () => listFriendLinks() });
  const friends = useMemo(() => splitFriends(links.data ?? []).friends, [links.data]);
  const full = chosen.size + 1 >= GROUP_MAX_PEOPLE;

  const make = useMutation({
    mutationFn: () => createGroup(title, [...chosen]),
    onSuccess: async (id) => {
      await queryClient.invalidateQueries({ queryKey: ['groups'] });
      router.replace(`/groups/${id}`);
    },
  });

  const toggle = (id: string) =>
    setChosen((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else if (!full) next.add(id);
      return next;
    });

  const nameCheck = validateGroupTitle(title);
  const ready = nameCheck.ok && chosen.size > 0;

  return (
    <Screen>
      <TopBar title="New group" />
      <Field
        label="Group name"
        value={title}
        onChangeText={setTitle}
        placeholder="Bio study group"
        autoCapitalize="sentences"
        maxLength={GROUP_TITLE_MAX}
      />
      <Label>{chosen.size > 0 ? `Friends in it (${chosen.size})` : 'Friends in it'}</Label>
      {links.isLoading ? <LoadingState /> : null}
      {links.data && friends.length === 0 ? (
        <Body muted>A group is for friends. Add some from your Profile first.</Body>
      ) : null}
      <FriendPicker
        friends={friends}
        chosen={chosen}
        onToggle={toggle}
        // Past thirty, the rest wait — and say why.
        disabled={
          full
            ? Object.fromEntries(
                friends.filter((f) => !chosen.has(f.person_id)).map((f) => [f.person_id, `A group is ${GROUP_MAX_PEOPLE} people at most`]),
              )
            : {}
        }
      />
      <Body muted>Only the people in it can see a group. Anyone in it can add their own friends, and anyone can leave.</Body>
      {make.isError ? <Notice tone="error">{(make.error as Error).message}</Notice> : null}
      <Button label="Make the group" onPress={() => make.mutate()} busy={make.isPending} disabled={!ready} />
    </Screen>
  );
}
