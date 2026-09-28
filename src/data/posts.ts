import { supabase, type Db } from './supabase';
import { isMissingColumn, isMissingTable } from '../core/db-errors';
import {
  FEED_PAGE,
  POST_IMAGE_LINK_SECONDS,
  validateComment,
  validateDraft,
  type Audience,
  type Draft,
  type FeedCursor,
  type FeedPost,
  type PostComment,
} from '../core/posts';
import type { Reaction } from '../core/emoji';
import { throwIfGated } from './moderation';

/**
 * Posts, the feed, comments and reactions (NOTES §52, migration 0027).
 *
 * The shape of `src/data/social.ts`: reads of other people come from views
 * (`feed_posts`, `post_comment_people`, `post_reaction_people`), every one of
 * them filtered by 0027's single rule for who sees a post; writes that need a
 * rule are functions (`create_post`, `edit_post`, `add_comment`), because
 * `posts` and `post_comments` have no insert or update policy.
 */

export class PostsUnavailableError extends Error {
  constructor() {
    super('Posts are not switched on yet.');
    this.name = 'PostsUnavailableError';
  }
}

function missingFunction(error: { code?: string | null } | null | undefined): boolean {
  return !!error && (error.code === 'PGRST202' || error.code === '42883');
}

function unavailable(error: { code?: string | null } | null | undefined): boolean {
  return isMissingTable(error) || isMissingColumn(error) || missingFunction(error);
}

async function currentUserId(db: Db = supabase): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

const POST_COLUMNS =
  'id, author_id, author_name, author_username, author_avatar, body, audience, image_path, image_width, image_height, set_id, set_title, set_cards, streak_days, pet, created_at, edited_at, comments';

/**
 * PostgREST wants a timestamp inside `or=(…)` quoted: it has colons and a plus
 * sign, which that syntax reads as its own. An id is a uuid and needs nothing.
 */
function olderThan(cursor: FeedCursor): string {
  const at = `"${cursor.created_at}"`;
  return `created_at.lt.${at},and(created_at.eq.${at},id.lt.${cursor.id})`;
}

// ------------------------------------------------------------ the feed --

/**
 * One page of the feed, newest first: friends' posts and everyone's public
 * ones, minus anybody on either side of a block — 0027's `post_visible` decides,
 * in the view, so nothing is fetched and then skipped.
 */
export async function listFeed(
  cursor: FeedCursor | null = null,
  authorId: string | null = null,
  db: Db = supabase,
): Promise<FeedPost[]> {
  let query = db.from('feed_posts').select(POST_COLUMNS);
  if (authorId) query = query.eq('author_id', authorId);
  if (cursor) query = query.or(olderThan(cursor));
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(FEED_PAGE);

  if (unavailable(error)) throw new PostsUnavailableError();
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as FeedPost[];
}

/** One post — or null for one that is gone or that the caller may not see, alike. */
export async function getPost(id: string, db: Db = supabase): Promise<FeedPost | null> {
  const { data, error } = await db.from('feed_posts').select(POST_COLUMNS).eq('id', id).maybeSingle();
  if (unavailable(error)) throw new PostsUnavailableError();
  if (error) throw new Error(error.message);
  return (data ?? null) as unknown as FeedPost | null;
}

// ------------------------------------------------------------- posting --

/** A photo ready to post: already shrunk (src/ui/shrink-image.ts), and its size. */
export interface PostPhoto {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Post something.
 *
 * A photo is uploaded first and the post made second, so a failure part way
 * leaves no post pointing at nothing. If the post is refused after the upload,
 * the upload is taken back — best effort, and logged if it cannot be.
 */
export async function createPost(
  draft: Draft,
  photo: PostPhoto | null,
  db: Db = supabase,
): Promise<string> {
  const check = validateDraft({ ...draft, photo: !!photo });
  if (!check.ok) throw new Error(check.reason);

  let imagePath: string | null = null;
  if (photo) {
    const me = await currentUserId(db);
    imagePath = `${me}/${Date.now()}.jpg`;
    const { error } = await db.storage
      .from('post-images')
      .upload(imagePath, photo.blob, { contentType: 'image/jpeg', upsert: false });
    if (error) {
      if (/bucket not found/i.test(error.message)) throw new PostsUnavailableError();
      throw new Error(error.message);
    }
  }

  const { data, error } = await db.rpc('create_post', {
    p_body: check.body,
    p_audience: draft.audience,
    p_image_path: imagePath,
    p_image_width: photo ? Math.round(photo.width) : null,
    p_image_height: photo ? Math.round(photo.height) : null,
    p_set_id: draft.setId ?? null,
    p_streak: !!draft.streak,
  });

  if (error) {
    if (imagePath) {
      const undo = await db.storage.from('post-images').remove([imagePath]);
      if (undo.error) console.warn(`[posts] could not remove an unposted photo: ${undo.error.message}`);
    }
    await throwIfGated(error, db);
    if (unavailable(error)) throw new PostsUnavailableError();
    if (error.code === 'P0001') throw new Error("That's a lot of posts for one day. Try again tomorrow.");
    if (error.code === 'P0002') throw new Error("That set isn't shared, so it can't go in a post.");
    if (error.code === '22023') throw new Error('There is no streak to share yet — study today and it starts.');
    throw new Error(error.message);
  }
  return data as string;
}

/** Change what a post says, or who sees it. Words changed are marked edited. */
export async function editPost(id: string, body: string, audience: Audience, db: Db = supabase): Promise<void> {
  const { error } = await db.rpc('edit_post', { p_id: id, p_body: body.trim(), p_audience: audience });
  await throwIfGated(error, db);
  if (unavailable(error)) throw new PostsUnavailableError();
  if (error?.code === '23514') throw new Error('A post needs some words, or a photo, set or streak.');
  if (error?.code === 'P0002') throw new Error('That post is gone.');
  if (error) throw new Error(error.message);
}

/**
 * Take a post down, and its photo with it.
 *
 * The row first: once it is gone, 0027's storage policy serves the photo to
 * nobody but its owner, whether or not the file is removed. Removing the file is
 * best effort for that reason, and logged when it fails.
 */
export async function deletePost(post: Pick<FeedPost, 'id' | 'image_path'>, db: Db = supabase): Promise<void> {
  const { error } = await db.from('posts').delete().eq('id', post.id);
  if (unavailable(error)) throw new PostsUnavailableError();
  if (error) throw new Error(error.message);
  if (post.image_path) {
    const removed = await db.storage.from('post-images').remove([post.image_path]);
    if (removed.error) console.warn(`[posts] post deleted, photo not removed: ${removed.error.message}`);
  }
}

// ------------------------------------------------------------ comments --

export async function listComments(postId: string, db: Db = supabase): Promise<PostComment[]> {
  const { data, error } = await db
    .from('post_comment_people')
    .select('id, post_id, author_id, author_name, author_username, author_avatar, body, created_at')
    .eq('post_id', postId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (unavailable(error)) throw new PostsUnavailableError();
  if (error) throw new Error(error.message);
  return (data ?? []) as PostComment[];
}

export async function addComment(postId: string, raw: string, db: Db = supabase): Promise<void> {
  const check = validateComment(raw);
  if (!check.ok) throw new Error(check.reason);
  const { error } = await db.rpc('add_comment', { p_post: postId, p_body: check.body });
  await throwIfGated(error, db);
  if (unavailable(error)) throw new PostsUnavailableError();
  if (error?.code === 'P0001') throw new Error('That is a lot of comments at once — give it a moment.');
  if (error?.code === 'P0002') throw new Error("That post isn't there any more.");
  if (error) throw new Error(error.message);
}

/** Your own comment, or any comment under your own post (0027's delete policy). */
export async function deleteComment(id: string, db: Db = supabase): Promise<void> {
  const { data, error } = await db.from('post_comments').delete().eq('id', id).select('id');
  if (unavailable(error)) throw new PostsUnavailableError();
  if (error) throw new Error(error.message);
  // A delete RLS refused comes back as success with nothing removed. Said, not
  // swallowed — the silent kind is the failure this project keeps paying for.
  if ((data ?? []).length === 0) throw new Error("That comment couldn't be removed.");
}

// ----------------------------------------------------------- reactions --

/**
 * Reactions on these posts, shaped as the chat's `Reaction` so the same chips
 * and the same tally draw them — `message_id` carries the post's id.
 */
export async function listPostReactions(postIds: readonly string[], db: Db = supabase): Promise<Reaction[]> {
  if (postIds.length === 0) return [];
  const { data, error } = await db
    .from('post_reaction_people')
    .select('post_id, user_id, name, emoji')
    .in('post_id', [...postIds]);
  if (unavailable(error)) return [];
  if (error) throw new Error(error.message);
  return ((data ?? []) as { post_id: string; user_id: string; name: string | null; emoji: string }[]).map((r) => ({
    message_id: r.post_id,
    user_id: r.user_id,
    name: r.name,
    emoji: r.emoji,
  }));
}

export async function reactToPost(postId: string, emoji: string, on: boolean, db: Db = supabase): Promise<void> {
  const user_id = await currentUserId(db);
  if (!on) {
    const { error } = await db
      .from('post_reactions')
      .delete()
      .eq('post_id', postId)
      .eq('user_id', user_id)
      .eq('emoji', emoji);
    if (unavailable(error)) throw new PostsUnavailableError();
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await db.from('post_reactions').insert({ post_id: postId, user_id, emoji });
  if (unavailable(error)) throw new PostsUnavailableError();
  // 23505: already reacted that way — the state asked for is the state.
  if (error && error.code !== '23505') throw new Error(error.message);
}

// -------------------------------------------------------- a set, peeked --

/** How many of a shared set's cards a post lets you flip through before opening it. */
export const PEEK_CARDS = 12;

/**
 * The first cards of a set a post carries, question and answer only — to flip
 * through in the feed. The owner's first idea was *"doomscrolling but it's for
 * flashcards"*, and this is where it lives: a set in a post can be tried
 * without leaving the feed, and opened when it is worth studying.
 *
 * Through `public_set_items`, so a set that was unshared, or whose owner is on
 * the other side of a block, simply has no cards to show.
 */
export async function previewCards(
  setId: string,
  db: Db = supabase,
): Promise<{ id: string; prompt: string; answer: string }[]> {
  const { data, error } = await db
    .from('public_set_items')
    .select('id, prompt, answer')
    .eq('study_set_id', setId)
    .order('created_at', { ascending: true })
    .limit(PEEK_CARDS);
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; prompt: string; answer: string }[];
}

// -------------------------------------------------------------- photos --

/**
 * Short-lived links to post photos, by path — ten minutes (POST_IMAGE_LINK_SECONDS,
 * and why). A photo with no link is left out.
 */
export async function postImageUrls(paths: readonly string[], db: Db = supabase): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await db.storage.from('post-images').createSignedUrls([...paths], POST_IMAGE_LINK_SECONDS);
  if (error || !data) return {};
  const links: Record<string, string> = {};
  for (const item of data) if (item.path && item.signedUrl && !item.error) links[item.path] = item.signedUrl;
  return links;
}

// ---------------------------------------------------------- delete my data --

/**
 * Everything this feature holds for one person: their posts (with their photos),
 * their comments anywhere, their reactions anywhere. Comments and reactions on
 * THEIR posts go with the posts; the ones they left under other people's posts
 * cascade from nothing of theirs — the omission NOTES §40 found for notes.
 */
export async function removeMyPosts(db: Db = supabase): Promise<void> {
  const me = await currentUserId(db);
  for (const table of ['post_comments', 'post_reactions', 'posts'] as const) {
    const { error } = await db.from(table).delete().eq('user_id', me);
    if (error && !unavailable(error)) throw new Error(error.message);
  }
  // The photos, best effort like every other storage removal in Delete my data.
  const { data: files, error } = await db.storage.from('post-images').list(me, { limit: 1000 });
  if (error) {
    if (!/bucket not found/i.test(error.message)) console.warn(`[posts] could not list photos: ${error.message}`);
    return;
  }
  if (files && files.length > 0) {
    const removed = await db.storage.from('post-images').remove(files.map((f) => `${me}/${f.name}`));
    if (removed.error) console.warn(`[posts] could not remove photos: ${removed.error.message}`);
  }
}
