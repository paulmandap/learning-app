import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, LoadingState, Notice, Screen, SectionRow } from '../../src/ui/components';
import { StatePanel } from '../../src/ui/states';
import { PersonAvatar } from '../../src/ui/avatar';
import { BlockSheet, ReportSheet, Sheet, SheetTitle } from '../../src/ui/people';
import { PostList } from '../../src/ui/post';
import { Composer } from '../../src/ui/nomi';
import { GLYPH } from '../../src/ui/glyphs';
import { space, TOUCH_TARGET, type, useTheme } from '../../src/ui/theme';
import { addComment, deleteComment, getPost, listComments } from '../../src/data/posts';
import { COMMENT_MAX_LENGTH, type PostComment } from '../../src/core/posts';
import { describeWhen } from '../../src/core/chat';
import { personName } from '../../src/core/social';
import { useSessionStore } from '../../src/data/session';

/**
 * One post and what people said under it (NOTES §52).
 *
 * The comment box sits under the comments, where the conversation ends, rather
 * than pinned to the bottom of the screen: a post can be long, and a pinned box
 * would sit on top of the ✦ the way the chat's did (NOTES §47.2).
 *
 * Who can take a comment down: whoever wrote it, and whoever wrote the post —
 * 0027's delete policy. Anybody else can report it or block who wrote it.
 */
export default function PostPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const postId = String(id);
  const myId = useSessionStore((s) => s.session?.user.id ?? '');

  const post = useQuery({ queryKey: ['post', postId], queryFn: () => getPost(postId) });
  const comments = useQuery({
    queryKey: ['post-comments', postId],
    queryFn: () => listComments(postId),
    enabled: !!post.data,
  });

  const [acting, setActing] = useState<PostComment | null>(null);
  const [reporting, setReporting] = useState<PostComment | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; name: string } | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['post', postId] });
    await queryClient.invalidateQueries({ queryKey: ['post-comments', postId] });
    await queryClient.invalidateQueries({ queryKey: ['feed'] });
  };
  const send = useMutation({ mutationFn: (text: string) => addComment(postId, text), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (commentId: string) => deleteComment(commentId),
    onSuccess: async () => {
      setActing(null);
      await refresh();
    },
  });

  if (post.isLoading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  // Gone, or not for you — the same answer on purpose, as for a person's page.
  if (!post.data) {
    return (
      <Screen centered>
        <StatePanel
          kind="empty"
          title="This post isn't here"
          detail="It may have been deleted, or it's only for the author's friends."
          action={{ label: 'Back to the feed', onPress: () => router.replace('/community') }}
        />
      </Screen>
    );
  }

  const mineToModerate = post.data.author_id === myId;
  const list = comments.data ?? [];
  const now = Date.now();

  return (
    <Screen>
      <PostList
        posts={[post.data]}
        myId={myId}
        full
        onChanged={async () => {
          await refresh();
          // Deleted or blocked: there is nothing left on this page to look at.
          const still = await getPost(postId).catch(() => null);
          if (!still) router.replace('/community');
        }}
      />

      <View style={{ gap: space.sm }}>
        <SectionRow title={list.length > 0 ? `Comments (${list.length})` : 'Comments'} />
        {comments.isLoading ? <LoadingState /> : null}
        {comments.data && list.length === 0 ? <Body muted>No comments yet. Say something.</Body> : null}
        {list.map((c) => (
          <CommentRow
            key={c.id}
            comment={c}
            mine={c.author_id === myId}
            when={describeWhen(Date.parse(c.created_at), now)}
            onOpenPerson={() => router.push(`/person/${c.author_id}`)}
            onMore={() => setActing(c)}
          />
        ))}
      </View>

      {send.isError ? <Notice tone="error">{(send.error as Error).message}</Notice> : null}
      <Composer
        onSend={(text) => send.mutate(text)}
        busy={send.isPending}
        placeholder="Write a comment"
        maxLength={COMMENT_MAX_LENGTH}
        emoji
      />

      {acting ? (
        <Sheet onClose={() => setActing(null)}>
          <SheetTitle>{acting.author_id === myId ? 'Your comment' : `${nameOf(acting)}'s comment`}</SheetTitle>
          {remove.isError ? <Notice tone="error">{(remove.error as Error).message}</Notice> : null}
          {acting.author_id === myId || mineToModerate ? (
            <>
              <Button
                label={acting.author_id === myId ? 'Delete comment' : 'Remove it from your post'}
                variant="secondary"
                onPress={() => remove.mutate(acting.id)}
                busy={remove.isPending}
              />
            </>
          ) : null}
          {acting.author_id !== myId ? (
            <>
              <Button
                label="Report this comment"
                variant="secondary"
                onPress={() => {
                  setReporting(acting);
                  setActing(null);
                }}
              />
              <Button
                label={`Block ${nameOf(acting)}`}
                variant="secondary"
                onPress={() => {
                  setBlocking({ id: acting.author_id, name: nameOf(acting) });
                  setActing(null);
                }}
              />
            </>
          ) : null}
          <Button label="Cancel" variant="secondary" onPress={() => setActing(null)} />
        </Sheet>
      ) : null}

      {reporting ? (
        <ReportSheet
          kind="comment"
          targetId={reporting.id}
          name={nameOf(reporting)}
          onBlock={() => {
            setBlocking({ id: reporting.author_id, name: nameOf(reporting) });
            setReporting(null);
          }}
          onClose={() => setReporting(null)}
        />
      ) : null}
      {blocking ? (
        <BlockSheet
          personId={blocking.id}
          name={blocking.name}
          onBlocked={() => void refresh()}
          onClose={() => setBlocking(null)}
        />
      ) : null}
    </Screen>
  );
}

function nameOf(c: PostComment): string {
  return personName({ name: c.author_name, username: c.author_username });
}

function CommentRow({
  comment,
  mine,
  when,
  onOpenPerson,
  onMore,
}: {
  comment: PostComment;
  mine: boolean;
  when: string;
  onOpenPerson: () => void;
  onMore: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${nameOf(comment)}'s profile`} onPress={onOpenPerson}>
        <PersonAvatar avatar={comment.author_avatar} userId={comment.author_id} name={nameOf(comment)} size={32} />
      </Pressable>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.caption, { color: t.textMuted }]}>
          <Text style={{ fontWeight: '700', color: t.text }}>{mine ? 'You' : nameOf(comment)}</Text>
          {`  ${when}`}
        </Text>
        <Text style={[type.body, { color: t.text }]} selectable>
          {comment.body}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="More"
        onPress={onMore}
        hitSlop={8}
        style={{ width: TOUCH_TARGET, height: 32, alignItems: 'flex-end', justifyContent: 'center' }}
      >
        <Text style={{ color: t.textMuted, fontSize: 18 }}>{GLYPH.more}</Text>
      </Pressable>
    </View>
  );
}
