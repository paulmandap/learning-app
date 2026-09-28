import { useMemo, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Label, LoadingState, Notice, Rows } from './components';
import { Sheet, SheetActions, SheetTitle } from './sheet';
import { PersonAvatar } from './avatar';
import { RowButton } from './people';
import { Icon } from './glyphs';
import { INPUT_FONT_SIZE, NO_FOCUS_RING, radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import { postLink, sendable, sharedOf, type FeedPost } from '../core/posts';
import { matchesQuery } from '../core/groups';
import { personName, splitFriends } from '../core/social';
import { listFriendLinks } from '../data/social';
import { listGroups, sendGroupMessage } from '../data/groups';
import { sendDirectMessage, startConversation } from '../data/messages';

/**
 * Sharing a post, inside Nomi (NOTES §62) — the owner: *"i don't want it to
 * share outside the app. i want to share it inside the app, just like how
 * facebook does it!"*
 *
 * Two ways, the two he chose: **to your feed**, with your own words if you
 * like (the composer, as a repost — 0034); and **to a friend or a group**, as
 * a message the chat draws as the post.
 *
 * What is shared is always the original: sharing a repost shares what it
 * shared, as Facebook does and as 0034's `create_post` does.
 *
 * Only a post everyone can see can be sent. A friends-only post sent to
 * somebody who is not the author's friend would arrive as a hole, which the
 * owner ruled out — so the choice is not offered, and says why.
 */

type Target = { kind: 'friend' | 'group'; id: string; name: string; avatar: string | null };

const keyOf = (to: Pick<Target, 'kind' | 'id'>) => `${to.kind}:${to.id}`;

export function ShareSheet({ post, onClose }: { post: FeedPost; onClose: () => void }) {
  const t = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const original = sharedOf(post) ?? post;
  const canSend = sendable(original);

  const links = useQuery({ queryKey: ['friend-links'], queryFn: () => listFriendLinks(), enabled: canSend });
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => listGroups(), enabled: canSend });
  const [query, setQuery] = useState('');
  const [sent, setSent] = useState<Set<string>>(new Set());

  const targets = useMemo<Target[]>(() => {
    const friends = splitFriends(links.data ?? []).friends.map((f) => ({
      kind: 'friend' as const,
      id: f.person_id,
      name: personName(f),
      avatar: f.avatar,
    }));
    const rooms = (groups.data ?? []).map((g) => ({ kind: 'group' as const, id: g.id, name: g.title, avatar: null }));
    return [...rooms, ...friends].filter((x) => matchesQuery(query, [x.name]));
  }, [links.data, groups.data, query]);

  const send = useMutation({
    mutationFn: async (to: Target) => {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const body = postLink(origin, original.id);
      if (to.kind === 'group') {
        await sendGroupMessage(to.id, body);
      } else {
        const conversation = await startConversation(to.id);
        await sendDirectMessage(conversation, body);
      }
    },
    onSuccess: async (_, to) => {
      setSent((s) => new Set(s).add(keyOf(to)));
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      await queryClient.invalidateQueries({ queryKey: ['groups'] });
    },
  });

  return (
    <Sheet onClose={onClose}>
      <SheetTitle>Share</SheetTitle>
      <SheetActions
        actions={[
          {
            icon: 'share',
            label: 'Share to your feed',
            detail: 'With your own words, if you like.',
            onPress: () => {
              onClose();
              router.push(`/post/new?share=${original.id}`);
            },
          },
        ]}
      />

      <Label>Send to</Label>
      {!canSend ? (
        <Body muted>Only a post everyone can see can be sent in a message.</Body>
      ) : (
        <>
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
              borderColor: t.border,
            }}
          >
            <Icon name="search" color={t.textMuted} size={18} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search friends and groups"
              placeholderTextColor={t.textMuted}
              accessibilityLabel="Search friends and groups"
              autoCapitalize="none"
              autoCorrect={false}
              style={[{ flex: 1, minHeight: TOUCH_TARGET, color: t.text, fontSize: INPUT_FONT_SIZE }, NO_FOCUS_RING]}
            />
          </View>
          {(links.isLoading || groups.isLoading) && targets.length === 0 ? <LoadingState /> : null}
          {send.isError ? <Notice tone="error">{(send.error as Error).message}</Notice> : null}
          {!links.isLoading && !groups.isLoading && targets.length === 0 ? (
            <Body muted>{query.trim() ? 'Nobody by that name.' : 'Add friends to send them posts.'}</Body>
          ) : null}
          <Rows card>
            {targets.map((to) => {
              const done = sent.has(keyOf(to));
              const sending = send.isPending && send.variables && keyOf(send.variables) === keyOf(to);
              return (
                <View
                  key={keyOf(to)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.md,
                    minHeight: TOUCH_TARGET + space.sm,
                    paddingHorizontal: space.lg,
                    paddingVertical: space.sm,
                  }}
                >
                  {to.kind === 'group' ? (
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: t.bg,
                      }}
                    >
                      <Icon name="people" color={t.accent} size={20} />
                    </View>
                  ) : (
                    <PersonAvatar avatar={to.avatar} userId={to.id} name={to.name} size={36} />
                  )}
                  <Text style={[type.body, { color: t.text, flex: 1 }]} numberOfLines={1}>
                    {to.name}
                  </Text>
                  {done ? (
                    <Text style={[type.label, { color: t.textMuted, fontWeight: '600' }]} accessibilityLabel={`Sent to ${to.name}`}>
                      Sent
                    </Text>
                  ) : (
                    <RowButton
                      label={`Send to ${to.name}`}
                      shown="Send"
                      primary
                      busy={!!sending}
                      onPress={() => send.mutate(to)}
                    />
                  )}
                </View>
              );
            })}
          </Rows>
        </>
      )}
    </Sheet>
  );
}
