import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Notice, Rows } from './components';
import { HeaderIconButton } from './menu';
import { PersonAvatar } from './avatar';
import { BlockSheet, ReportSheet } from './people';
import { Sheet, SheetActions, SheetTitle } from './sheet';
import { ReactionChips, ReactionRow } from './message-actions';
import { petFrame } from './pet';
import { Icon, type IconName } from './glyphs';
import { shareLink } from './share';
import { radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import { tallyReactions, type Reaction } from '../core/emoji';
import {
  agoShort,
  audienceLabel,
  commentLabel,
  HEART,
  heartsOf,
  otherReactions,
  POST_IMAGE_LINK_SECONDS,
  streakLine,
  type FeedPost,
} from '../core/posts';
import { petStage, toPetSpecies } from '../core/pet';
import { atUsername, personName } from '../core/social';
import {
  deletePost,
  listPostReactions,
  postImageUrls,
  previewCards,
  reactToPost,
  savedAmong,
  savePost,
} from '../data/posts';

/**
 * Posts, drawn (NOTES §52; redrawn in §57 from the owner's picture).
 *
 * `PostList` is the one way a list of posts reaches a screen — the feed, a
 * person's page, a single post and Saved all use it — so reacting, saving,
 * deleting, reporting and blocking behave the same wherever a post is. Three
 * copies of a post menu is how one of them ends up offering Delete on somebody
 * else's post.
 *
 * ## What the redesign changed
 *
 * Posts are separated by a hairline, not drawn as bordered boxes — a feed is
 * one stream, and ten boxes read as ten competing panels. The actions are
 * icons with counts, as every feed has them: a heart (❤️, the first of the six
 * reactions), comments, share, and save at the far end. The other five
 * reactions are still one tap into the post's sheet, and show as chips.
 */

/** A photo keeps its own shape, between a tall portrait and a wide landscape. */
const PHOTO_RATIO_MIN = 0.8;
const PHOTO_RATIO_MAX = 1.91;

/** How long "Link copied" stays beside the share button. */
const COPIED_MS = 2500;

export function PostList({
  posts,
  myId,
  full = false,
  onChanged,
  onComment,
}: {
  posts: readonly FeedPost[];
  myId: string;
  /** A single post on its own page: all of its words, and its ⋯ in the header. */
  full?: boolean;
  /** After a delete, a reaction, a block — so the screen can refresh what it holds. */
  onChanged: () => void | Promise<void>;
  /** On a post's own page, the comment button goes to the comment box. */
  onComment?: () => void;
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
  const { data: saved = new Set<string>() } = useQuery({
    queryKey: ['post-saves', ids],
    queryFn: () => savedAmong(ids),
    enabled: ids.length > 0,
  });

  const byPost = useMemo(() => {
    const map = new Map<string, Reaction[]>();
    for (const r of reactions) map.set(r.message_id, [...(map.get(r.message_id) ?? []), r]);
    return map;
  }, [reactions]);

  const [acting, setActing] = useState<FeedPost | null>(null);
  const [reporting, setReporting] = useState<FeedPost | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; name: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

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
    onError: (err, { id }) => setFailed({ id, message: (err as Error).message }),
  });
  const remove = useMutation({
    mutationFn: (post: FeedPost) => deletePost(post),
    onSuccess: async () => {
      setActing(null);
      await refresh();
    },
  });
  const save = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => savePost(id, on),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['post-saves'] });
      await queryClient.invalidateQueries({ queryKey: ['saved'] });
    },
    onError: (err, { id }) => setFailed({ id, message: (err as Error).message }),
  });

  const now = Date.now();
  const only = full ? posts[0] : undefined;

  return (
    <View>
      {/* A post on its own page keeps its ⋯ in the header, beside the back
          control, as the owner's picture has it. */}
      {only ? (
        <Stack.Screen
          options={{
            title: 'Post',
            headerRight: () => <HeaderIconButton icon="more" label="More" onPress={() => setActing(only)} />,
          }}
        />
      ) : null}

      <Rows>
        {posts.map((post) => {
          const list = byPost.get(post.id) ?? [];
          const hearts = heartsOf(list, myId);
          const isSaved = saved.has(post.id);
          return (
            <PostCard
              key={post.id}
              post={post}
              full={full}
              when={agoShort(Date.parse(post.created_at), now)}
              imageUrl={post.image_path ? links[post.image_path] ?? null : null}
              hearts={hearts}
              others={tallyReactions(otherReactions(list), myId)}
              saved={isSaved}
              copied={copied === post.id}
              failed={failed?.id === post.id ? failed.message : null}
              onOpenPerson={() => router.push(`/person/${post.author_id}`)}
              onComment={full ? onComment : () => router.push(`/post/${post.id}`)}
              onMore={full ? undefined : () => setActing(post)}
              onHeart={() => {
                setFailed(null);
                toggle.mutate({ id: post.id, emoji: HEART, on: !hearts.mine });
              }}
              onSave={() => {
                setFailed(null);
                save.mutate({ id: post.id, on: !isSaved });
              }}
              onShare={async () => {
                setFailed(null);
                const outcome = await shareLink(`${nameOf(post)} on Nomi`, `/post/${post.id}`);
                if (outcome === 'copied') setCopied(post.id);
                if (outcome === 'failed') setFailed({ id: post.id, message: "Couldn't share that just now." });
              }}
              onToggleReaction={(emoji, on) => toggle.mutate({ id: post.id, emoji, on })}
            />
          );
        })}
      </Rows>

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
 * One post: who, then what, then what you can do.
 *
 * Who can see it is on every post, your own included, because the one mistake
 * a social feed must make hard is forgetting who is reading — an icon now, as
 * in the picture (people for friends, a globe for everyone), named for a
 * screen reader rather than hidden from one.
 */
function PostCard({
  post,
  full,
  when,
  imageUrl,
  hearts,
  others,
  saved,
  copied,
  failed,
  onOpenPerson,
  onComment,
  onMore,
  onHeart,
  onSave,
  onShare,
  onToggleReaction,
}: {
  post: FeedPost;
  full: boolean;
  when: string;
  imageUrl: string | null;
  hearts: { count: number; mine: boolean };
  others: ReturnType<typeof tallyReactions>;
  saved: boolean;
  copied: boolean;
  failed: string | null;
  onOpenPerson: () => void;
  onComment?: () => void;
  onMore?: () => void;
  onHeart: () => void;
  onSave: () => void;
  onShare: () => void;
  onToggleReaction: (emoji: string, on: boolean) => void;
}) {
  const t = useTheme();
  const name = nameOf(post);
  const handle = atUsername(post.author_username);
  const everyone = post.audience === 'everyone';

  return (
    <View style={{ gap: space.md, paddingVertical: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${name}'s profile`}
          onPress={onOpenPerson}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <PersonAvatar avatar={post.author_avatar} userId={post.author_id} name={name} size={40} />
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>
              {name}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.tight }}>
              <Text style={[type.caption, { color: t.textMuted, flexShrink: 1 }]} numberOfLines={1}>
                {[handle && handle !== name ? handle : null, when, post.edited_at ? 'edited' : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              <View
                accessible
                accessibilityRole="image"
                accessibilityLabel={`Seen by ${audienceLabel(post.audience).toLowerCase()}`}
              >
                <Icon name={everyone ? 'everyone' : 'people'} color={t.textMuted} size={15} />
              </View>
            </View>
          </View>
        </Pressable>
        {onMore ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="More"
            onPress={onMore}
            hitSlop={8}
            style={{ width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: 'flex-end', justifyContent: 'center' }}
          >
            <Icon name="more" color={t.textMuted} size={22} />
          </Pressable>
        ) : null}
      </View>

      {post.body ? (
        <Text style={[type.body, { color: t.text }]} numberOfLines={full ? undefined : 8} selectable>
          {post.body}
        </Text>
      ) : null}

      <PostAttachment post={post} imageUrl={imageUrl} />

      <ReactionChips tallies={others} alignEnd={false} onToggle={onToggleReaction} />

      {/* The actions: heart, comments and share together, save at the far end
          — the owner's picture, and every feed he named. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg, marginLeft: -space.sm }}>
        <ActionIcon
          icon="heart"
          label={hearts.mine ? 'Remove heart' : 'Heart'}
          count={hearts.count}
          on={hearts.mine}
          onColor={t.danger}
          onPress={onHeart}
        />
        {onComment ? (
          <ActionIcon icon="comment" label={commentLabel(post.comments)} count={post.comments} onPress={onComment} />
        ) : null}
        <ActionIcon icon="share" label="Share" onPress={onShare} />
        {copied ? <Text style={[type.caption, { color: t.textMuted }]}>Link copied</Text> : null}
        <View style={{ flex: 1 }} />
        <ActionIcon
          icon="bookmark"
          label={saved ? 'Remove from saved' : 'Save post'}
          on={saved}
          onColor={t.accent}
          onPress={onSave}
        />
      </View>
      {failed ? <Notice tone="error">{failed}</Notice> : null}
    </View>
  );
}

/**
 * An icon in a post's action row, with its count. Filled as well as coloured
 * when it is on — never hue alone.
 */
function ActionIcon({
  icon,
  label,
  count,
  on = false,
  onColor,
  onPress,
}: {
  icon: IconName;
  label: string;
  count?: number;
  on?: boolean;
  onColor?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const color = on && onColor ? onColor : t.textMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        minWidth: TOUCH_TARGET,
        minHeight: TOUCH_TARGET,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: count ? 'flex-start' : 'center',
        gap: space.tight,
        paddingHorizontal: space.sm,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon name={icon} color={color} size={22} filled={on} />
      {count ? <Text style={[type.label, { color: t.textMuted }]}>{count}</Text> : null}
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
        borderRadius: radius.md,
        overflow: 'hidden',
        backgroundColor: t.card,
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
 * Tap the card to see the answer; Next for the next one; "Study this set"
 * opens it to study properly. Twelve cards at most — enough to know whether a
 * set is worth studying, and a feed is not the place to study it. The owner's
 * first idea for the social side: *"doomscrolling but it's for flashcards"*.
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
  const open = () => router.push(`/set/${setId}`);
  return (
    <View style={{ gap: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: t.card }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open the set ${title}`}
        onPress={open}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, opacity: pressed ? 0.7 : 1 })}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: radius.sm,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: t.bg,
          }}
        >
          <Icon name="set" color={t.accent} size={20} />
        </View>
        <Text style={[type.bodyStrong, { color: t.text, flex: 1 }]} numberOfLines={2}>
          {title}
          <Text style={[type.body, { color: t.textMuted }]}>{` — ${cards} card${cards === 1 ? '' : 's'}`}</Text>
        </Text>
      </Pressable>

      {isLoading ? null : card ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={flipped ? `Answer: ${card.answer}. Tap for the question.` : `Question: ${card.prompt}. Tap for the answer.`}
          onPress={() => setFlipped((f) => !f)}
          style={({ pressed }) => ({
            minHeight: 120,
            padding: space.lg,
            gap: space.sm,
            borderRadius: radius.md,
            justifyContent: 'center',
            backgroundColor: t.bg,
            borderWidth: 1,
            // The answer side wears the accent — a mark as well as the label,
            // so a card caught mid-flip says which side it is on.
            borderColor: flipped ? t.accent : t.border,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Text style={[type.caption, { color: flipped ? t.accent : t.textMuted, textAlign: 'center' }]}>
            {flipped ? 'Answer' : 'Question'}
          </Text>
          <Text style={[flipped ? type.body : type.bodyStrong, { color: t.text, textAlign: 'center' }]}>
            {flipped ? card.answer : card.prompt}
          </Text>
          <Text style={[type.caption, { color: t.textMuted, textAlign: 'center' }]}>Tap to flip</Text>
        </Pressable>
      ) : (
        <Body muted>No cards to show.</Body>
      )}

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        {card ? (
          <Text style={[type.caption, { color: t.textMuted }]}>
            {index + 1} of {data.length}
          </Text>
        ) : (
          <View />
        )}
        {data.length > 1 ? (
          <TextButton
            label={index + 1 < data.length ? 'Next card' : 'Start again'}
            shown={index + 1 < data.length ? 'Next' : 'Start again'}
            trailing={index + 1 < data.length ? 'forward' : undefined}
            onPress={() => {
              setIndex((i) => (i + 1 < data.length ? i + 1 : 0));
              setFlipped(false);
            }}
          />
        ) : null}
      </View>
      <TextButton label={`Study ${title}`} shown="Study this set" onPress={open} />
    </View>
  );
}

/** A small accent link inside a post — "Next", "Study this set". */
function TextButton({
  label,
  shown,
  trailing,
  onPress,
}: {
  label: string;
  shown: string;
  trailing?: IconName;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        minHeight: 32,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.hair,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={[type.label, { color: t.accent, fontWeight: '600' }]}>{shown}</Text>
      {trailing ? <Icon name={trailing} color={t.accent} size={16} /> : null}
    </Pressable>
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
        borderRadius: radius.md,
        backgroundColor: t.card,
      }}
    >
      <Image source={petFrame(species, stage?.index ?? 0)} style={{ width: 88, height: 88 }} resizeMode="contain" />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.display, { color: t.text }]}>{`${days} day${days === 1 ? '' : 's'}`}</Text>
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
  const [confirming, setConfirming] = useState(false);
  const name = nameOf(post);

  // Delete asks once, in place — it takes the photo and every comment with
  // it — and the confirmation is the one filled button, in the danger colour.
  if (confirming) {
    return (
      <Sheet onClose={onClose}>
        <SheetTitle>Delete this post?</SheetTitle>
        <Body muted>Its comments and reactions go with it.</Body>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button label="Delete post" variant="danger" onPress={onDelete} busy={busy} />
        <Button label="Keep it" variant="secondary" onPress={() => setConfirming(false)} disabled={busy} />
      </Sheet>
    );
  }

  return (
    <Sheet onClose={onClose}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ReactionRow onReact={onReact} disabled={busy} />
      <SheetActions
        actions={
          mine
            ? [
                { icon: 'edit', label: 'Edit post', onPress: onEdit, disabled: busy },
                { icon: 'trash', label: 'Delete post', onPress: () => setConfirming(true), destructive: true, disabled: busy },
              ]
            : [
                { icon: 'person', label: `See ${name}'s profile`, onPress: onViewProfile, disabled: busy },
                { icon: 'report', label: 'Report this post', onPress: onReport, destructive: true, disabled: busy },
                { icon: 'block', label: `Block ${name}`, onPress: onBlock, destructive: true, disabled: busy },
              ]
        }
      />
    </Sheet>
  );
}
