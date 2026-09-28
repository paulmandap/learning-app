import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Body,
  Button,
  Field,
  Label,
  LoadingState,
  Notice,
  Rows,
  Screen,
  TopBar,
} from '../../../src/ui/components';
import { StatePanel } from '../../../src/ui/states';
import { PersonAvatar } from '../../../src/ui/avatar';
import { RowButton } from '../../../src/ui/people';
import { Sheet, SheetTitle } from '../../../src/ui/sheet';
import { FriendPicker } from '../../../src/ui/friend-picker';
import { LeaveSheet } from '../../../src/ui/group-sheets';
import { space, TOUCH_TARGET, type, useTheme } from '../../../src/ui/theme';
import {
  addGroupMembers,
  getGroup,
  leaveGroup,
  listGroupMembers,
  removeGroupMember,
  renameGroup,
} from '../../../src/data/groups';
import { listFriendLinks } from '../../../src/data/social';
import { GROUP_MAX_PEOPLE, GROUP_TITLE_MAX, peopleLine, roomLeft, type GroupMember } from '../../../src/core/groups';
import { personName, splitFriends } from '../../../src/core/social';
import { useSessionStore } from '../../../src/data/session';

/**
 * Who is in a group, and what can be done about it (NOTES §58).
 *
 * Anyone in it: see who is in it, add their own friends, leave. Whoever made
 * it — or took it over when the maker left — also renames it and takes people
 * out. Somebody across a block from you is not listed, as they are hidden
 * everywhere else; the count at the top still counts them.
 */
export default function GroupInfo() {
  const t = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id, add } = useLocalSearchParams<{ id: string; add?: string }>();
  const groupId = String(id);
  const myId = useSessionStore((s) => s.session?.user.id ?? '');

  const group = useQuery({ queryKey: ['group', groupId], queryFn: () => getGroup(groupId) });
  const members = useQuery({
    queryKey: ['group-members', groupId],
    queryFn: () => listGroupMembers(groupId),
    enabled: !!group.data,
  });

  const [title, setTitle] = useState<string | null>(null);
  const [adding, setAdding] = useState(add === '1');
  const [removing, setRemoving] = useState<GroupMember | null>(null);
  const [leaving, setLeaving] = useState(false);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['group', groupId] });
    await queryClient.invalidateQueries({ queryKey: ['group-members', groupId] });
    await queryClient.invalidateQueries({ queryKey: ['groups'] });
  };

  const rename = useMutation({
    mutationFn: (next: string) => renameGroup(groupId, next),
    onSuccess: async () => {
      setTitle(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => removeGroupMember(groupId, userId),
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
    },
  });
  const leave = useMutation({
    mutationFn: () => leaveGroup(groupId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['groups'] });
      await queryClient.invalidateQueries({ queryKey: ['dm-unread'] });
      router.replace('/community');
    },
  });

  const g = group.data;

  if (group.isLoading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }
  if (!g) {
    return (
      <Screen centered>
        <StatePanel
          kind="empty"
          title="This group isn't here"
          detail="You may have left it, or been taken out of it."
          action={{ label: 'Back to your messages', onPress: () => router.replace('/community') }}
        />
      </Screen>
    );
  }

  const draft = title ?? g.title;
  const changed = title !== null && title.trim() !== g.title;

  return (
    <Screen>
      <TopBar title={g.title} />
      <Body muted>{peopleLine(g.member_count)}. Only the people in it can see this group.</Body>

      {g.i_own ? (
        <View style={{ gap: space.sm }}>
          <Field
            label="Group name"
            value={draft}
            onChangeText={setTitle}
            placeholder="A name for the group"
            autoCapitalize="sentences"
            maxLength={GROUP_TITLE_MAX}
          />
          {rename.isError ? <Notice tone="error">{(rename.error as Error).message}</Notice> : null}
          {changed ? <Button label="Save the name" onPress={() => rename.mutate(draft)} busy={rename.isPending} /> : null}
        </View>
      ) : null}

      <Button
        label="Add people"
        variant="outline"
        onPress={() => setAdding(true)}
        disabled={roomLeft(g.member_count) === 0}
      />
      {roomLeft(g.member_count) === 0 ? <Body muted>{`This group is full — ${GROUP_MAX_PEOPLE} people.`}</Body> : null}

      <Label>Who is in it</Label>
      {members.isLoading ? <LoadingState /> : null}
      {remove.isError ? <Notice tone="error">{(remove.error as Error).message}</Notice> : null}
      <Rows card>
        {(members.data ?? []).map((m) => (
          <MemberRow
            key={m.user_id}
            member={m}
            me={m.user_id === myId}
            canRemove={g.i_own && m.user_id !== myId}
            onOpen={() => router.push(`/person/${m.user_id}`)}
            onRemove={() => setRemoving(m)}
          />
        ))}
      </Rows>

      {/* Not "Leave group": that is the sheet's button, and one label for
          both is how a press lands on the wrong one (HANDOFF, NOTES §52.8). */}
      <Button label="Leave this group" variant="secondary" onPress={() => setLeaving(true)} />

      {adding ? (
        <AddPeopleSheet
          groupId={groupId}
          inGroup={new Set((members.data ?? []).map((m) => m.user_id))}
          room={roomLeft(g.member_count)}
          onDone={async () => {
            setAdding(false);
            await refresh();
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}

      {removing ? (
        <Sheet onClose={() => setRemoving(null)}>
          <SheetTitle>{`Take ${personName(removing)} out?`}</SheetTitle>
          <Body muted>They won&apos;t see the group any more. What they sent stays. You can add them again later.</Body>
          <Button label="Take them out" variant="danger" onPress={() => remove.mutate(removing.user_id)} busy={remove.isPending} />
          <Button label="Cancel" variant="secondary" onPress={() => setRemoving(null)} disabled={remove.isPending} />
        </Sheet>
      ) : null}

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
    </Screen>
  );
}

function MemberRow({
  member,
  me,
  canRemove,
  onOpen,
  onRemove,
}: {
  member: GroupMember;
  me: boolean;
  canRemove: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const t = useTheme();
  const name = personName(member);
  const line = [me ? 'You' : null, member.is_owner ? 'Made the group' : null].filter(Boolean).join(' · ');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name}${line ? `. ${line}` : ''}`}
        onPress={onOpen}
        disabled={me}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          minHeight: TOUCH_TARGET,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <PersonAvatar avatar={member.avatar} userId={member.user_id} name={name} size={36} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>
            {name}
          </Text>
          {line ? <Text style={[type.caption, { color: t.textMuted }]}>{line}</Text> : null}
        </View>
      </Pressable>
      {canRemove ? <RowButton label="Remove" onPress={onRemove} /> : null}
    </View>
  );
}

/** Friends to add — the ones already in it shown, and not choosable. */
function AddPeopleSheet({
  groupId,
  inGroup,
  room,
  onDone,
  onClose,
}: {
  groupId: string;
  inGroup: ReadonlySet<string>;
  room: number;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const links = useQuery({ queryKey: ['friend-links'], queryFn: () => listFriendLinks() });
  const friends = useMemo(() => splitFriends(links.data ?? []).friends, [links.data]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const add = useMutation({ mutationFn: () => addGroupMembers(groupId, [...chosen]), onSuccess: onDone });

  const disabled: Record<string, string> = {};
  for (const f of friends) {
    if (inGroup.has(f.person_id)) disabled[f.person_id] = 'Already in the group';
    else if (chosen.size >= room && !chosen.has(f.person_id)) disabled[f.person_id] = `A group is ${GROUP_MAX_PEOPLE} people at most`;
  }

  return (
    <Sheet onClose={onClose}>
      <SheetTitle>Add people</SheetTitle>
      <Body muted>Only your friends — and they&apos;ll see the group&apos;s messages from now on, not what was said before.</Body>
      {links.isLoading ? <LoadingState /> : null}
      {links.data && friends.length === 0 ? <Body muted>Add friends from your Profile first.</Body> : null}
      <FriendPicker
        friends={friends}
        chosen={chosen}
        disabled={disabled}
        onToggle={(pid) =>
          setChosen((now) => {
            const next = new Set(now);
            if (next.has(pid)) next.delete(pid);
            else next.add(pid);
            return next;
          })
        }
      />
      {add.isError ? <Notice tone="error">{(add.error as Error).message}</Notice> : null}
      <Button
        label={chosen.size > 0 ? `Add ${chosen.size}` : 'Add'}
        onPress={() => add.mutate()}
        busy={add.isPending}
        disabled={chosen.size === 0}
      />
    </Sheet>
  );
}
