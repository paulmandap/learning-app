import { useMemo, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Notice } from './components';
import { PersonAvatar } from './avatar';
import { BlockSheet, ReportSheet, Sheet, SheetTitle } from './people';
import { ReactionChips } from './message-actions';
import { petFrame } from './pet';
import { GLYPH } from './glyphs';
import { radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import { describeWhen } from '../core/chat';
import { REACTIONS, tallyReactions, type Reaction } from '../core/emoji';
import { audienceLabel, commentLabel, POST_IMAGE_LINK_SECONDS, streakLine, type FeedPost } from '../core/posts';
import { petStage, toPetSpecies } from '../core/pet';
import { atUsername, personName } from '../core/social';
import { deletePost, listPostReactions, postImageUrls, previewCards, reactToPost } from '../data/posts';

/**
 * Posts, drawn (NOTES §52).
 *
 * `PostList` is the one way a list of posts reaches a screen — the feed, a
 * person's page and a single post all use it — so reacting, deleting,
 * reporting and blocking behave the same wherever a post is. Three copies of a
 * post menu is how one of them ends up offering Delete on somebody else's post.
 */

/** A photo keeps its own shape, between a tall portrait and a wide landscape. */
const PHOTO_RATIO_MIN = 0.8;
const PHOTO_RATIO_MAX = 1.91;

export function PostList({
  posts,
  myId,
  full = false,
  onChanged,
}: {
  posts: readonly FeedPost[];
  myId: string;
  /** A single post on its own page: all of its words, and no "comments" link to itself. */
  full?: boolean;
  /** After a delete, a reaction, a block — so the screen can refresh what it holds. */
  onChanged: () => void | Promise<void>;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const ids = useMemo(() => posts.map((p) => p.id), [posts]);
  const paths = useMemo(() => posts.map((p) => p.image_path).filter((p): p is string => !!p), [posts]);

  const { data: reactions = [] } = useQuery({
    queryKey: ['post-reactions', ids],
    queryFn: () => listPostReactions(ids),
    enabled: ids.length > 0,
  });
  const { data: links = {} } = useQuery({
    queryKey: ['post-images', paths],
    queryFn: () => postImageUrls(paths),
    enabled: paths.length > 0,
    // The links last ten minutes (NOTES §52.7); fresh ones two minutes early.
    // Not on a timer: a photo already on screen stays on screen when its link
    // lapses, and re-fetching every one of them every eight minutes would be a
    // download of the whole feed for nothing.
    staleTime: (POST_IMAGE_LINK_SECONDS - 120) * 1000,
  });

  const byPost = useMemo(() => {
    const map = new Map<string, Reaction[]>();
    for (const r of reactions) map.set(r.message_id, [...(map.get(r.message_id) ?? []), r]);
    return map;
  }, [reactions]);

  const [acting, setActing] = useState<FeedPost | null>(null);
  const [reporting, setReporting] = useState<FeedPost | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; name: string } | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['post-reactions'] });
    await onChanged();
  };
  const toggle = useMutation({
    mutationFn: ({ id, emoji, on }: { id: string; emoji: string; on: boolean }) => reactToPost(id, emoji, on),
    onSuccess: async () => {
      setActing(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (post: FeedPost) => deletePost(post),
    onSuccess: async () => {
      setActing(null);
      await refresh();
    },
  });

  const now = Date.now();

  return (
    <View style={{ gap: space.md }}>
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          mine={post.author_id === myId}
          full={full}
          when={describeWhen(Date.parse(post.created_at), now)}
          imageUrl={post.image_path ? links[post.image_path] ?? null : null}
          tallies={tallyReactions(byPost.get(post.id) ?? [], myId)}
          onOpenPerson={() => router.push(`/person/${post.author_id}`)}
          onOpen={full ? undefined : () => router.push(`/post/${post.id}`)}
          onMore={() => setActing(post)}
          onToggleReaction={(emoji, on) => toggle.mutate({ id: post.id, emoji, on })}
        />
      ))}

      {acting ? (
        <PostSheet
          post={acting}
          mine={acting.author_id === myId}
          busy={toggle.isPending || remove.isPending}
          error={(toggle.error as Error | null)?.message ?? (remove.error as Error | null)?.message ?? null}
          onReact={(emoji) => {
            const already = (byPost.get(acting.id) ?? []).some((r) => r.user_id === myId && r.emoji === emoji);
            toggle.mutate({ id: acting.id, emoji, on: !already });
          }}
          onEdit={() => {
            setActing(null);
            router.push(`/post/new?edit=${acting.id}`);
          }}
          onDelete={() => remove.mutate(acting)}
          onViewProfile={() => {
            setActing(null);
            router.push(`/person/${acting.author_id}`);
          }}
          onReport={() => {
            setReporting(acting);
            setActing(null);
          }}
          onBlock={() => {
            setBlocking({ id: acting.author_id, name: nameOf(acting) });
            setActing(null);
          }}
          onClose={() => setActing(null)}
        />
      ) : null}

      {reporting ? (
        <ReportSheet
          kind="post"
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
          onBlocked={() => void onChanged()}
          onClose={() => setBlocking(null)}
        />
      ) : null}
    </View>
  );
}

function nameOf(post: FeedPost): string {
  return personName({ name: post.author_name, username: post.author_username });
}

/**
 * One post.
 *
 * Who and when first, with who can see it beside the time — "Friends" or
 * "Everyone" on every post, your own included, because the one mistake a
 * social feed must make hard is forgetting who is reading.
 */
function PostCard({
  post,
  mine,
  full,
  when,
  imageUrl,
  tallies,
  onOpenPerson,
  onOpen,
  onMore,
  onToggleReaction,
}: {
  post: FeedPost;
  mine: boolean;
  full: boolean;
  when: string;
  imageUrl: string | null;
  tallies: ReturnType<typeof tallyReactions>;
  onOpenPerson: () => void;
  onOpen?: () => void;
  onMore: () => void;
  onToggleReaction: (emoji: string, on: boolean) => void;
}) {
  const t = useTheme();
  const name = mine ? 'You' : nameOf(post);
  const handle = atUsername(post.author_username);

  return (
    <View
      style={{
        gap: space.md,
        padding: space.lg,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.card,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${nameOf(post)}'s profile`}
          onPress={onOpenPerson}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <PersonAvatar avatar={post.author_avatar} userId={post.author_id} name={nameOf(post)} size={36} />
          <View style={{ flex: 1 }}>
            <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>
              {name}
              {handle && !mine && handle !== name ? (
                <Text style={[type.body, { color: t.textMuted }]}>{`  ${handle}`}</Text>
              ) : null}
            </Text>
            <Text style={[type.caption, { color: t.textMuted }]}>
              {when} · {audienceLabel(post.audience)}
              {post.edited_at ? ' · edited' : ''}
            </Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="More"
          onPress={onMore}
          hitSlop={8}
          style={{ width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: 'flex-end', justifyContent: 'center' }}
        >
          <Text style={{ color: t.textMuted, fontSize: 22 }}>{GLYPH.more}</Text>
        </Pressable>
      </View>

      {post.body ? (
        <Text style={[type.body, { color: t.text }]} numberOfLines={full ? undefined : 8} selectable>
          {post.body}
        </Text>
      ) : null}

      <PostAttachment post={post} imageUrl={imageUrl} />

      <ReactionChips tallies={tallies} alignEnd={false} onToggle={onToggleReaction} />

      <View style={{ flexDirection: 'row', gap: space.lg }}>
        <FooterButton label="React" glyph={GLYPH.react} onPress={onMore} />
        {onOpen ? <FooterButton label={commentLabel(post.comments)} onPress={onOpen} /> : null}
      </View>
    </View>
  );
}

function FooterButton({ label, glyph, onPress }: { label: string; glyph?: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({ minHeight: 32, justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
    >
      <Text style={[type.label, { color: t.textMuted, fontWeight: '600' }]}>
        {glyph ? `${glyph} ` : ''}
        {label}
      </Text>
    </Pressable>
  );
}

/** A photo, a set, or a streak — at most one, as 0027 allows. */
function PostAttachment({ post, imageUrl }: { post: FeedPost; imageUrl: string | null }) {
  if (post.image_path) {
    return <PostPhoto uri={imageUrl} width={post.image_width ?? 4} height={post.image_height ?? 3} />;
  }
  if (post.set_id) return <SetPeek setId={post.set_id} title={post.set_title} cards={post.set_cards} />;
  if (post.streak_days) return <StreakBrag days={post.streak_days} pet={post.pet} />;
  return null;
}

/** The photo at its own shape, with that space held while it loads. */
export function PostPhoto({ uri, width, height }: { uri: string | null; width: number; height: number }) {
  const t = useTheme();
  const ratio = Math.min(PHOTO_RATIO_MAX, Math.max(PHOTO_RATIO_MIN, width / Math.max(1, height)));
  return (
    <View
      style={{
        width: '100%',
        aspectRatio: ratio,
        borderRadius: radius.sm,
        overflow: 'hidden',
        backgroundColor: t.bg,
      }}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="cover"
          accessibilityLabel="Photo"
        />
      ) : null}
    </View>
  );
}

/**
 * A shared set, to flip through in the feed.
 *
 * Tap the card to see the answer; Next for the next one; the title opens the
 * set to study it properly. Twelve cards at most — enough to know whether a set
 * is worth studying, and a feed is not the place to study it.
 */
function SetPeek({ setId, title, cards }: { setId: string; title: string | null; cards: number }) {
  const t = useTheme();
  const router = useRouter();
  const { data = [], isLoading } = useQuery({
    queryKey: ['peek', setId],
    queryFn: () => previewCards(setId),
    enabled: title !== null,
  });
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  if (title === null) {
    return <Body muted>This set isn&apos;t shared any more.</Body>;
  }

  const card = data[index];
  return (
    <View style={{ gap: space.sm, padding: space.md, borderRadius: radius.sm, borderWidth: 1, borderColor: t.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open the set ${title}`}
        onPress={() => router.push(`/set/${setId}`)}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.sm, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flex: 1 }}>
          <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={2}>
            {title}
          </Text>
          <Text style={[type.caption, { color: t.textMuted }]}>
            {cards} card{cards === 1 ? '' : 's'} · Open to study
          </Text>
        </View>
        <Text style={{ color: t.textMuted, fontSize: 22 }}>{GLYPH.forward}</Text>
      </Pressable>

      {isLoading ? null : card ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={flipped ? `Answer: ${card.answer}. Tap for the question.` : `Question: ${card.prompt}. Tap for the answer.`}
            onPress={() => setFlipped((f) => !f)}
            style={({ pressed }) => ({
              minHeight: 110,
              padding: space.lg,
              borderRadius: radius.sm,
              justifyContent: 'center',
              backgroundColor: flipped ? t.bg : t.card,
              borderWidth: 1,
              borderColor: flipped ? t.accent : t.border,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={[type.caption, { color: t.textMuted, marginBottom: space.xs }]}>
              {flipped ? 'Answer' : 'Question'} · {index + 1} of {data.length}
            </Text>
            <Text style={[flipped ? type.body : type.bodyStrong, { color: t.text }]}>
              {flipped ? card.answer : card.prompt}
            </Text>
          </Pressable>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <FooterButton label={flipped ? 'Show question' : 'Show answer'} onPress={() => setFlipped((f) => !f)} />
            {data.length > 1 ? (
              <FooterButton
                label={index + 1 < data.length ? 'Next card' : 'Start again'}
                onPress={() => {
                  setIndex((i) => (i + 1 < data.length ? i + 1 : 0));
                  setFlipped(false);
                }}
              />
            ) : null}
          </View>
        </>
      ) : (
        <Body muted>No cards to show.</Body>
      )}
    </View>
  );
}

/** "12 days in a row — my potato is large now", with the pet at that size. */
function StreakBrag({ days, pet }: { days: number; pet: string | null }) {
  const t = useTheme();
  const species = toPetSpecies(pet);
  const stage = petStage(days);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.lg,
        padding: space.md,
        borderRadius: radius.sm,
        backgroundColor: t.bg,
      }}
    >
      <Image source={petFrame(species, stage?.index ?? 0)} style={{ width: 88, height: 88 }} resizeMode="contain" />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.title, { color: t.text }]}>{`${days} day${days === 1 ? '' : 's'}`}</Text>
        <Text style={[type.body, { color: t.textMuted }]}>{streakLine(days, species)}</Text>
      </View>
    </View>
  );
}

/**
 * What you can do to a post: react first, where a thumb lands, then the rest.
 *
 * Yours: edit, delete — delete asking once, in place, since it takes the photo
 * and every comment with it. Somebody else's: their profile, report, block.
 */
function PostSheet({
  post,
  mine,
  busy,
  error,
  onReact,
  onEdit,
  onDelete,
  onViewProfile,
  onReport,
  onBlock,
  onClose,
}: {
  post: FeedPost;
  mine: boolean;
  busy: boolean;
  error: string | null;
  onReact: (emoji: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onViewProfile: () => void;
  onReport: () => void;
  onBlock: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const [confirming, setConfirming] = useState(false);
  const name = nameOf(post);

  return (
    <Sheet onClose={onClose}>
      <SheetTitle>{mine ? 'Your post' : `${name}'s post`}</SheetTitle>
      {error ? <Notice tone="error">{error}</Notice> : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {REACTIONS.map((r) => (
          <Pressable
            key={r.emoji}
            accessibilityRole="button"
            accessibilityLabel={r.label}
            onPress={() => onReact(r.emoji)}
            disabled={busy}
            style={({ pressed }) => ({
              width: 46,
              height: 46,
              borderRadius: 23,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: pressed ? t.card : 'transparent',
            })}
          >
            <Text style={{ fontSize: 24 }}>{r.emoji}</Text>
          </Pressable>
        ))}
      </View>

      {mine ? (
        confirming ? (
          <>
            <Body>Delete this post? Its comments and reactions go with it.</Body>
            <Button label="Delete post" variant="danger" onPress={onDelete} busy={busy} />
            <Button label="Keep it" variant="secondary" onPress={() => setConfirming(false)} disabled={busy} />
          </>
        ) : (
          <>
            <Button label="Edit post" variant="secondary" onPress={onEdit} disabled={busy} />
            <Button label="Delete post" variant="secondary" onPress={() => setConfirming(true)} disabled={busy} />
          </>
        )
      ) : (
        <>
          <Button label={`See ${name}'s profile`} variant="secondary" onPress={onViewProfile} disabled={busy} />
          <Button label="Report this post" variant="secondary" onPress={onReport} disabled={busy} />
          <Button label={`Block ${name}`} variant="secondary" onPress={onBlock} disabled={busy} />
        </>
      )}
      <Button label="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
    </Sheet>
  );
}
