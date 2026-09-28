import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, LoadingState, Notice, Screen, SectionRow } from '../../src/ui/components';
import { StatePanel } from '../../src/ui/states';
import { MyAvatar, PersonAvatar } from '../../src/ui/avatar';
import { BlockSheet, ReportSheet } from '../../src/ui/people';
import { Sheet, SheetActions, SheetTitle } from '../../src/ui/sheet';
import { PostList } from '../../src/ui/post';
import { Composer } from '../../src/ui/nomi';
import { Icon } from '../../src/ui/glyphs';
import { CONTENT_MAX_WIDTH, space, TOUCH_TARGET, type, useTheme } from '../../src/ui/theme';
import { addComment, addReply, deleteComment, getPost, likeComment, listComments } from '../../src/data/posts';
import { agoShort, COMMENT_MAX_LENGTH, replyingTo, threadComments, type PostComment } from '../../src/core/posts';
import { personName } from '../../src/core/social';
import { useSessionStore } from '../../src/data/session';

/**
 * One post and what people said under it (NOTES §52; redrawn in §57).
 *
 * ## The comment box is pinned to the bottom now
 *
 * It sat under the comments, where the conversation ends, because a box pinned
 * to the bottom would have sat on the ✦ (NOTES §47.2). The owner's picture pins
 * it, as every feed does, so the ✦ is kept off a post's page the way it is kept
 * off the chat rooms (app/_layout.tsx) — and the box is always where the thumb
 * is, however long the post.
 *
 * ## Replies and hearts (0031)
 *
 * A comment can be answered, one level deep: replies sit under the comment,
 * indented, oldest first. "Reply" puts "Replying to …" over the box and the
 * cursor in it; the database attaches a reply to a reply to the comment above.
 * A heart on a comment is counted, never named.
 *
 * Who can take a comment down: whoever wrote it, and whoever wrote the post —
 * 0027's delete policy. Its replies go with it. Anybody else can report it or
 * block who wrote it.
 */
export default function PostPage() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
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
  const threads = useMemo(() => threadComments(comments.data ?? []), [comments.data]);

  const [acting, setActing] = useState<PostComment | null>(null);
  const [reporting, setReporting] = useState<PostComment | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; name: string } | null>(null);
  const [replyTo, setReplyTo] = useState<PostComment | null>(null);
  const [focus, setFocus] = useState(0);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['post', postId] });
    await queryClient.invalidateQueries({ queryKey: ['post-comments', postId] });
    await queryClient.invalidateQueries({ queryKey: ['feed'] });
  };
  const send = useMutation({
    mutationFn: (text: string) => (replyTo ? addReply(replyTo.id, text) : addComment(postId, text)),
    onSuccess: async () => {
      setReplyTo(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (commentId: string) => deleteComment(commentId),
    onSuccess: async () => {
      setActing(null);
      await refresh();
    },
  });
  const like = useMutation({
    mutationFn: ({ commentId, on }: { commentId: string; on: boolean }) => likeComment(commentId, on),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['post-comments', postId] }),
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
  const total = comments.data?.length ?? 0;
  const now = Date.now();
  const startReply = (c: PostComment) => {
    setReplyTo(c);
    setFocus((f) => f + 1);
  };
  const row = (c: PostComment, reply: boolean) => (
    <CommentRow
      key={c.id}
      comment={c}
      reply={reply}
      when={agoShort(Date.parse(c.created_at), now)}
      onOpenPerson={() => router.push(`/person/${c.author_id}`)}
      onMore={() => setActing(c)}
      onReply={() => startReply(c)}
      onLike={() => like.mutate({ commentId: c.id, on: !c.liked })}
    />
  );
  const actingThread = acting ? threads.find((th) => th.comment.id === acting.id) : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ alignItems: 'center', paddingHorizontal: space.lg, paddingBottom: space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: space.md }}>
          <PostList
            posts={[post.data]}
            myId={myId}
            full
            onComment={() => setFocus((f) => f + 1)}
            onChanged={async () => {
              await refresh();
              // Deleted or blocked: there is nothing left on this page to look at.
              const still = await getPost(postId).catch(() => null);
              if (!still) router.replace('/community');
            }}
          />
          <View style={{ height: 1, backgroundColor: t.border, opacity: 0.6 }} />

          <SectionRow title={total > 0 ? `Comments (${total})` : 'Comments'} />
          {comments.isLoading ? <LoadingState /> : null}
          {comments.data && total === 0 ? <Body muted>No comments yet. Say something.</Body> : null}
          {like.isError ? <Notice tone="error">{(like.error as Error).message}</Notice> : null}
          {threads.map((th) => (
            <View key={th.comment.id} style={{ gap: space.md }}>
              {row(th.comment, false)}
              {th.replies.map((r) => row(r, true))}
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Pinned: the box stays where the thumb is (see the note above). */}
      <View
        style={{
          alignItems: 'center',
          paddingHorizontal: space.lg,
          paddingTop: space.sm,
          paddingBottom: insets.bottom + space.sm,
          borderTopWidth: 1,
          borderTopColor: t.border,
          backgroundColor: t.bg,
        }}
      >
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: space.sm }}>
          {send.isError ? <Notice tone="error">{(send.error as Error).message}</Notice> : null}
          {replyTo ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Text style={[type.caption, { color: t.textMuted, flex: 1 }]} numberOfLines={1}>
                {replyingTo(nameOf(replyTo))}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel the reply"
                onPress={() => setReplyTo(null)}
                hitSlop={12}
              >
                <Icon name="close" color={t.textMuted} size={18} />
              </Pressable>
            </View>
          ) : null}
          <Composer
            onSend={(text) => send.mutate(text)}
            busy={send.isPending}
            placeholder={replyTo ? `Reply to ${nameOf(replyTo)}` : 'Write a comment'}
            maxLength={COMMENT_MAX_LENGTH}
            leading={<MyAvatar size={36} />}
            focusSignal={focus}
          />
        </View>
      </View>

      {acting ? (
        <Sheet onClose={() => setActing(null)}>
          <SheetTitle>{acting.author_id === myId ? 'Your comment' : `${nameOf(acting)}'s comment`}</SheetTitle>
          {remove.isError ? <Notice tone="error">{(remove.error as Error).message}</Notice> : null}
          <SheetActions
            actions={[
              acting.author_id === myId || mineToModerate
                ? {
                    icon: 'trash',
                    label: acting.author_id === myId ? 'Delete comment' : 'Remove it from your post',
                    // A comment takes its replies with it (0031's cascade) —
                    // said before, not discovered after.
                    detail: actingThread && actingThread.replies.length > 0 ? 'Its replies go with it.' : undefined,
                    onPress: () => remove.mutate(acting.id),
                    destructive: true,
                    disabled: remove.isPending,
                  }
                : null,
              acting.author_id !== myId
                ? {
                    icon: 'report',
                    label: 'Report this comment',
                    destructive: true,
                    onPress: () => {
                      setReporting(acting);
                      setActing(null);
                    },
                  }
                : null,
              acting.author_id !== myId
                ? {
                    icon: 'block',
                    label: `Block ${nameOf(acting)}`,
                    destructive: true,
                    onPress: () => {
                      setBlocking({ id: acting.author_id, name: nameOf(acting) });
                      setActing(null);
                    },
                  }
                : null,
            ]}
          />
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
    </View>
  );
}

function nameOf(c: PostComment): string {
  return personName({ name: c.author_name, username: c.author_username });
}

/**
 * One comment: who and when on one line, what they said, then Reply and a
 * heart — the owner's picture. A reply is indented under its comment with a
 * smaller picture, which is all that says "this answers that".
 *
 * Reply and the heart are small words and a small icon, and each still has a
 * 44 pt target: their own height plus the slop around them.
 */
function CommentRow({
  comment,
  reply,
  when,
  onOpenPerson,
  onMore,
  onReply,
  onLike,
}: {
  comment: PostComment;
  reply: boolean;
  when: string;
  onOpenPerson: () => void;
  onMore: () => void;
  onReply: () => void;
  onLike: () => void;
}) {
  const t = useTheme();
  const name = nameOf(comment);
  return (
    <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start', marginLeft: reply ? 48 : 0 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${name}'s profile`} onPress={onOpenPerson}>
        <PersonAvatar avatar={comment.author_avatar} userId={comment.author_id} name={name} size={reply ? 28 : 36} />
      </Pressable>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.caption, { color: t.textMuted }]} numberOfLines={1}>
          <Text style={[type.label, { fontWeight: '700', color: t.text }]}>{name}</Text>
          {`  ${when}`}
        </Text>
        <Text style={[type.body, { color: t.text }]} selectable>
          {comment.body}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reply to ${name}`}
            onPress={onReply}
            hitSlop={8}
            style={({ pressed }) => ({ minHeight: 28, justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={[type.caption, { color: t.textMuted, fontWeight: '600' }]}>Reply</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={comment.liked ? 'Remove your heart from this comment' : 'Heart this comment'}
            accessibilityState={{ selected: comment.liked }}
            onPress={onLike}
            hitSlop={8}
            style={({ pressed }) => ({
              minHeight: 28,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.xs,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            {/* Filled and coloured when it is yours — never colour alone. */}
            <Icon name="heart" color={comment.liked ? t.danger : t.textMuted} size={16} filled={comment.liked} />
            {comment.likes > 0 ? (
              <Text style={[type.caption, { color: t.textMuted }]}>{comment.likes}</Text>
            ) : null}
          </Pressable>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="More"
        onPress={onMore}
        hitSlop={8}
        style={{ width: TOUCH_TARGET, height: 32, alignItems: 'flex-end', justifyContent: 'center' }}
      >
        <Icon name="more" color={t.textMuted} size={20} />
      </Pressable>
    </View>
  );
}
