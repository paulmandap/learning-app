import { PET_THRESHOLDS, petStage, type PetSpecies } from './pet';

/**
 * Posts, the feed, comments and reactions — the parts decidable without a
 * database or a screen (NOTES §52, migration 0027).
 *
 * The owner: *"this is built to socialize. just like how you can post/brag
 * about your job in facebook and linkedin."* A post is words, a photo, one
 * shared set or a streak brag; friends see it by default; the feed is friends'
 * posts and everyone's public ones, newest first.
 *
 * Every limit here is a COPY of 0027's, held to it by `tests/posts.test.ts`.
 */

/** Who sees a post. Mirrors `posts_audience_check` (0027). */
export const AUDIENCES = ['friends', 'everyone'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** Friends unless the author says otherwise — the owner's choice (2026-09-27). */
export const DEFAULT_AUDIENCE: Audience = 'friends';

/** Longest post. Mirrors `posts_body_check` (0027). */
export const POST_MAX_LENGTH = 2000;
/** Longest comment. Mirrors `post_comments.body`'s check (0027). */
export const COMMENT_MAX_LENGTH = 1000;
/** Mirrors `create_post` (0027). */
export const POSTS_PER_DAY = 20;
/**
 * Mirrors `add_comment` (0027), and the chat's own limit. `add_reply` (0031)
 * counts the same rows, so comments and replies share it.
 */
export const COMMENTS_PER_MINUTE = 10;
/** How many posts the feed asks for at a time. */
export const FEED_PAGE = 20;

/**
 * A photo's longest side before upload. A post's picture is read on a phone;
 * 1280 px is sharp there at about 150–300 KB, against 3–12 MB straight from the
 * camera, and photos are what fill the free storage first.
 */
export const POST_IMAGE_MAX_SIDE = 1280;

/**
 * How long a link to a post's photo lasts: ten minutes, not the hour avatars
 * get (NOTES §52.7).
 *
 * A signed link is a key to the file for as long as it lasts, whoever holds it
 * and whatever changes — it was checked when it was made, not when it is used.
 * So when somebody stops being allowed to see a post (unfriended, blocked, the
 * post made friends-only or deleted), a link they already had keeps working
 * until it runs out. An hour was the window; ten minutes is. The feed asks for
 * fresh links two minutes before these lapse.
 */
export const POST_IMAGE_LINK_SECONDS = 600;

/** A row of `feed_posts` (0027). */
export interface FeedPost {
  id: string;
  author_id: string;
  author_name: string | null;
  author_username: string | null;
  author_avatar: string | null;
  body: string;
  audience: Audience;
  image_path: string | null;
  image_width: number | null;
  image_height: number | null;
  set_id: string | null;
  /** Null when the set is no longer shared — the post stays and says so. */
  set_title: string | null;
  set_cards: number;
  streak_days: number | null;
  pet: string | null;
  created_at: string;
  edited_at: string | null;
  comments: number;
  /**
   * The post this one shares, and what it says (0034, NOTES §62). Absent
   * before 0034; null for a post that shares nothing. A row whose original the
   * reader may not see never arrives at all — the database leaves it out.
   */
  shared_post_id?: string | null;
  shared_author_id?: string | null;
  shared_author_name?: string | null;
  shared_author_username?: string | null;
  shared_author_avatar?: string | null;
  shared_body?: string | null;
  shared_audience?: Audience | null;
  shared_image_path?: string | null;
  shared_image_width?: number | null;
  shared_image_height?: number | null;
  shared_set_id?: string | null;
  shared_set_title?: string | null;
  shared_set_cards?: number | null;
  shared_streak_days?: number | null;
  shared_pet?: string | null;
  shared_created_at?: string | null;
}

/**
 * The post a repost shares, as a post of its own — drawn inside the repost,
 * and opened on its own page. Null for a post that shares nothing.
 */
export function sharedOf(post: FeedPost): FeedPost | null {
  if (!post.shared_post_id || !post.shared_author_id || !post.shared_created_at) return null;
  return {
    id: post.shared_post_id,
    author_id: post.shared_author_id,
    author_name: post.shared_author_name ?? null,
    author_username: post.shared_author_username ?? null,
    author_avatar: post.shared_author_avatar ?? null,
    body: post.shared_body ?? '',
    audience: post.shared_audience ?? 'friends',
    image_path: post.shared_image_path ?? null,
    image_width: post.shared_image_width ?? null,
    image_height: post.shared_image_height ?? null,
    set_id: post.shared_set_id ?? null,
    set_title: post.shared_set_title ?? null,
    set_cards: post.shared_set_cards ?? 0,
    streak_days: post.shared_streak_days ?? null,
    pet: post.shared_pet ?? null,
    created_at: post.shared_created_at,
    edited_at: null,
    comments: 0,
  };
}

/** What sharing a post to your feed shares: the original, for a repost (as 0034 does). */
export function originalOf(post: FeedPost): string {
  return post.shared_post_id ?? post.id;
}

// ------------------------------------------------------- a post, sent --

/**
 * A post sent to a friend or a group (NOTES §62) is a message holding the
 * post's link, which the chat draws as the post. No new column: the link is
 * the message, so it goes wherever a message goes, and the post itself is
 * read through `feed_posts` by whoever is reading — the one rule decides.
 */
export function postLink(origin: string, id: string): string {
  return `${origin.replace(/\/$/, '')}/post/${id}`;
}

const POST_LINK = /https?:\/\/\S+?\/post\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-z-])/i;

/**
 * The post a message carries, if it carries one, and whatever else it says.
 * Any origin: the link says where it was sent from, and the post is looked up
 * by its id wherever the message is read.
 */
export function postInMessage(body: string): { postId: string; rest: string } | null {
  const found = POST_LINK.exec(body);
  if (!found) return null;
  const rest = (body.slice(0, found.index) + body.slice(found.index + found[0].length)).replace(/\s+/g, ' ').trim();
  return { postId: found[1]!.toLowerCase(), rest };
}

/**
 * A message as one line — an inbox's last line, a reply's quote: a post sent
 * reads as "Sent a post", not as a link nobody wants to read.
 */
export function messagePreview(body: string): string {
  const carried = postInMessage(body);
  return carried ? carried.rest || 'Sent a post' : body;
}

/**
 * May this post be sent in a message? Only one everyone can see — a
 * friends-only post sent to somebody who is not the author's friend would
 * arrive as a hole, which the owner ruled out (§62).
 */
export function sendable(post: Pick<FeedPost, 'audience'>): boolean {
  return post.audience === 'everyone';
}

/**
 * A row of `post_comment_people` (0027; 0031 added the last three). Until 0031
 * is applied they read as a comment with no parent, no hearts and not yours.
 */
export interface PostComment {
  id: string;
  post_id: string;
  author_id: string;
  author_name: string | null;
  author_username: string | null;
  author_avatar: string | null;
  body: string;
  created_at: string;
  /** The comment this one replies to, or null for a comment on the post itself. */
  parent_id: string | null;
  /** Hearts from people the reader can see. Counted, never named. */
  likes: number;
  /** Is one of them the reader's? */
  liked: boolean;
}

/** A comment on the post, with the replies to it underneath, oldest first. */
export interface CommentThread {
  comment: PostComment;
  replies: PostComment[];
}

/**
 * Comments as the post page shows them: each comment on the post, oldest
 * first, with its replies under it (0031 keeps replies one level deep).
 *
 * A reply whose comment is not in the list is left out rather than shown loose:
 * the comment it answers is hidden from the reader — its writer is across a
 * block — and an answer to something you cannot see reads as a non sequitur
 * addressed to nobody.
 */
export function threadComments(comments: readonly PostComment[]): CommentThread[] {
  const byTime = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const threads = new Map<string, CommentThread>();
  for (const c of byTime) if (!c.parent_id) threads.set(c.id, { comment: c, replies: [] });
  for (const c of byTime) if (c.parent_id) threads.get(c.parent_id)?.replies.push(c);
  return [...threads.values()];
}

/** The ❤️ the heart button on a post gives — the first of the six reactions. */
export const HEART = '❤️';

/**
 * A post's hearts: how many, and whether one is the reader's. The heart button
 * is ❤️ alone; the other five reactions stay in the post's sheet and show as
 * chips (`otherReactions`).
 */
export function heartsOf(
  reactions: readonly { user_id: string; emoji: string }[],
  myId: string,
): { count: number; mine: boolean } {
  const hearts = reactions.filter((r) => r.emoji === HEART);
  return { count: hearts.length, mine: hearts.some((r) => r.user_id === myId) };
}

/** Every reaction but the heart, which the heart button already shows. */
export function otherReactions<T extends { emoji: string }>(reactions: readonly T[]): T[] {
  return reactions.filter((r) => r.emoji !== HEART);
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago, the way a feed says it: "now", "5m", "2h", "3d", then the
 * date — "Sep 12", with the year once it is not this one.
 *
 * Not the chat's `describeWhen`, which gives a clock time for today: in a
 * conversation "10:24 AM" places a message among others, while beside a post
 * "2h" is what says how fresh it is (the owner's picture).
 */
export function agoShort(then: number, now: number): string {
  const gone = Math.max(0, now - then);
  if (gone < MINUTE) return 'now';
  if (gone < HOUR) return `${Math.floor(gone / MINUTE)}m`;
  if (gone < DAY) return `${Math.floor(gone / HOUR)}h`;
  if (gone < 7 * DAY) return `${Math.floor(gone / DAY)}d`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Replying to Maria", over the comment box while a reply is being written. */
export function replyingTo(name: string): string {
  return `Replying to ${name}`;
}

/** What is being posted, before it is. */
export interface Draft {
  body: string;
  audience: Audience;
  photo?: boolean;
  setId?: string | null;
  streak?: boolean;
  /** A post shared to your feed (0034). */
  sharedPostId?: string | null;
}

export type DraftCheck = { ok: true; body: string } | { ok: false; reason: string };

/**
 * Is this postable?
 *
 * The same two rules as `posts_one_attachment` and `posts_not_empty`: at most
 * one of a photo, a set, a streak and a shared post (0034), and never nothing
 * at all. Any of those may go without words; words may go without anything.
 */
export function validateDraft(draft: Draft): DraftCheck {
  const body = draft.body.trim();
  const attachments = [draft.photo, !!draft.setId, draft.streak, !!draft.sharedPostId].filter(Boolean).length;
  if (attachments > 1) return { ok: false, reason: 'One photo, set, streak or shared post per post.' };
  if (body.length === 0 && attachments === 0) return { ok: false, reason: 'Write something first.' };
  if (body.length > POST_MAX_LENGTH) {
    return { ok: false, reason: `That is a long post. Keep it under ${POST_MAX_LENGTH} characters.` };
  }
  return { ok: true, body };
}

export type CommentCheck = { ok: true; body: string } | { ok: false; reason: string };

export function validateComment(raw: string): CommentCheck {
  const body = raw.trim();
  if (body.length === 0) return { ok: false, reason: 'Type something first.' };
  if (body.length > COMMENT_MAX_LENGTH) {
    return { ok: false, reason: `That is a long comment. Keep it under ${COMMENT_MAX_LENGTH} characters.` };
  }
  return { ok: true, body };
}

/** "Friends" / "Everyone" — beside every post, so nobody forgets who can see it. */
export function audienceLabel(audience: Audience): string {
  return audience === 'everyone' ? 'Everyone' : 'Friends';
}

/** What choosing it means, in the composer. */
export function audienceDetail(audience: Audience): string {
  return audience === 'everyone'
    ? 'Anyone signed in to Nomi can see it.'
    : 'Only your friends can see it.';
}

/** "3 comments" / "1 comment" / "Comment". */
export function commentLabel(count: number): string {
  if (count <= 0) return 'Comment';
  return `${count} comment${count === 1 ? '' : 's'}`;
}

// ------------------------------------------------------------ the feed --

/**
 * Where the next page starts: the oldest post on screen.
 *
 * By time AND id, because two posts in the same millisecond exist, and a
 * cursor on time alone would skip one of them for ever or show it twice.
 */
export interface FeedCursor {
  created_at: string;
  id: string;
}

export function nextCursor(page: readonly FeedPost[]): FeedCursor | null {
  if (page.length < FEED_PAGE) return null;
  const last = page[page.length - 1]!;
  return { created_at: last.created_at, id: last.id };
}

/**
 * Pages joined into one list, newest first, each post once.
 *
 * A post can arrive twice — one made while scrolling pushes everything down a
 * place, so the next page begins with what the last one ended on. Keeping the
 * first copy keeps its place.
 */
export function joinPages(pages: readonly (readonly FeedPost[])[]): FeedPost[] {
  const seen = new Set<string>();
  const out: FeedPost[] = [];
  for (const page of pages) {
    for (const post of page) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      out.push(post);
    }
  }
  return out;
}

// ----------------------------------------------------------- streak brag --

/**
 * Did the pet grow TODAY? True on the day a streak reaches 2, 5, 10 or 30 —
 * the day Progress offers to share it. Not on day one: a baby that hatched is
 * the start of a streak, not something to show off yet.
 */
export function petGrewToday(streak: number): boolean {
  return PET_THRESHOLDS.some((t, i) => i > 0 && t.at === streak);
}

/** The line on a streak post: "12 days in a row — my potato is large now." */
export function streakLine(days: number, pet: string | null): string {
  const stage = petStage(days);
  const animal = (pet ?? 'potato') as PetSpecies;
  const size = stage ? stage.name : 'baby';
  return `${days} day${days === 1 ? '' : 's'} in a row — my ${animal} is ${size === 'giant' ? 'fully grown' : `${size} now`}.`;
}
