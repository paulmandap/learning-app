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
/** Mirrors `add_comment` (0027), and the chat's own limit. */
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
}

/** A row of `post_comment_people` (0027). */
export interface PostComment {
  id: string;
  post_id: string;
  author_id: string;
  author_name: string | null;
  author_username: string | null;
  author_avatar: string | null;
  body: string;
  created_at: string;
}

/** What is being posted, before it is. */
export interface Draft {
  body: string;
  audience: Audience;
  photo?: boolean;
  setId?: string | null;
  streak?: boolean;
}

export type DraftCheck = { ok: true; body: string } | { ok: false; reason: string };

/**
 * Is this postable?
 *
 * The same two rules as `posts_one_attachment` and `posts_not_empty`: at most
 * one of a photo, a set and a streak, and never nothing at all. A photo or a
 * set may go without words; words may go without anything.
 */
export function validateDraft(draft: Draft): DraftCheck {
  const body = draft.body.trim();
  const attachments = [draft.photo, !!draft.setId, draft.streak].filter(Boolean).length;
  if (attachments > 1) return { ok: false, reason: 'One photo, set or streak per post.' };
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
