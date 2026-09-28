import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  messagePreview,
  originalOf,
  postInMessage,
  postLink,
  sendable,
  sharedOf,
  validateDraft,
  type FeedPost,
} from '../src/core/posts';
import { lastLine, quoteOf, type Conversation } from '../src/core/messages';
import { PRIVACY_POLICY } from '../src/core/legal';

/**
 * Sharing a post inside Nomi (NOTES §62, migration 0034).
 *
 * The owner's rule for a repost of something a reader may not see: *"they
 * should not be able to see it, just like facebook, there's no 'This post
 * isn't available' it will just look messy."* So every function and view
 * that reads a post gains one condition — the original must be visible too —
 * and each is held to its previous version with ONLY that allowed to differ:
 * a copy that dropped a block filter or a rate limit would otherwise pass.
 */

const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');
const sql = (file: string) => strip(readFileSync(`supabase/migrations/${file}`, 'utf8'));
const SQL = sql('0034_reposts.sql');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const ALSO = 'and public.shared_post_visible(p.shared_post_id)';
const privacy = PRIVACY_POLICY.sections.flatMap((s) => s.body).flat().join(' ');

function fnIn(text: string, name: string): string {
  const start = text.indexOf(`create or replace function public.${name}(`);
  expect(start, `no function named ${name}`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('$$;', start));
}
const fn = (name: string) => fnIn(SQL, name);

function viewIn(text: string, name: string): string {
  const start = text.search(new RegExp(`create (or replace )?view public\\.${name}\\b`));
  expect(start, `no view named ${name}`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf(';', start));
}

/** A view as it was, with `create view` and `create or replace view` read alike. */
const sameView = (v: string) => norm(v.replace(/create (or replace )?view/, 'create view'));

// ------------------------------------------------------------ the database --

describe('0034 builds on 0033, and says so', () => {
  it('refuses to run without it, before changing anything', () => {
    const check = SQL.indexOf("column_name = 'bio'");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(SQL.indexOf('alter table public.posts'));
  });
});

describe('a repost is a post that carries the post it shares', () => {
  it('goes when the original goes', () => {
    expect(SQL).toContain('add column if not exists shared_post_id uuid references public.posts (id) on delete cascade;');
  });

  it('still one thing at most, never nothing — 0027’s two rules, widened by name', () => {
    expect(norm(SQL)).toContain(
      'add constraint posts_one_attachment check (num_nonnulls(image_path, set_id, streak_days, shared_post_id) <= 1);',
    );
    expect(norm(SQL)).toContain(
      'add constraint posts_not_empty check (length(btrim(body)) > 0 or num_nonnulls(image_path, set_id, streak_days, shared_post_id) = 1);',
    );
  });

  it('the second half of the rule: the original exists and the caller may see it', () => {
    const helper = fn('shared_post_visible');
    expect(helper).toContain('select p_shared is null');
    expect(helper).toContain('and public.post_visible(o.user_id, o.audience)');
  });
});

describe('everything that reads a post asks both halves, and loses nothing', () => {
  it('can_see_post: 0027’s, plus the original', () => {
    const now = fn('can_see_post');
    expect(now).toContain(ALSO);
    expect(norm(now.replace(ALSO, ''))).toBe(norm(fnIn(sql('0027_posts_and_feed.sql'), 'can_see_post')));
  });

  it('can_see_comment: 0031’s, plus the original', () => {
    const now = fn('can_see_comment');
    expect(now).toContain(ALSO);
    expect(norm(now.replace(ALSO, ''))).toBe(norm(fnIn(sql('0031_comment_replies_likes_and_saves.sql'), 'can_see_comment')));
  });

  it('feed_posts: 0027’s columns as they were, the original’s at the end, both halves in the filter', () => {
    const now = viewIn(SQL, 'feed_posts');
    const before = viewIn(sql('0027_posts_and_feed.sql'), 'feed_posts');
    // Everything up to the comment count is 0027's, word for word.
    const head = (v: string) => norm(v.slice(v.indexOf('select'), v.indexOf('as comments') + 'as comments'.length));
    expect(head(now)).toBe(head(before));
    expect(now).toMatch(/where public\.post_visible\(p\.user_id, p\.audience\)\s+and public\.shared_post_visible\(p\.shared_post_id\);?$/);
    // The original's set only while it is still shared, like the post's own.
    expect(norm(now)).toContain("left join public.study_sets os on os.id = o.set_id and os.visibility = 'public' and os.status = 'ready'");
    expect(now).not.toMatch(/drop view/);
  });

  it('post_comment_people: 0031’s, plus the original', () => {
    const now = viewIn(SQL, 'post_comment_people');
    expect(now).toContain(ALSO);
    expect(sameView(now.replace(ALSO, ''))).toBe(sameView(viewIn(sql('0031_comment_replies_likes_and_saves.sql'), 'post_comment_people')));
  });

  it('post_reaction_people: 0027’s, plus the original', () => {
    const now = viewIn(SQL, 'post_reaction_people');
    expect(now).toContain(ALSO);
    expect(sameView(now.replace(ALSO, ''))).toBe(sameView(viewIn(sql('0027_posts_and_feed.sql'), 'post_reaction_people')));
  });

  it('report_content: 0033’s, plus the original, and a repost’s copy says it shared one', () => {
    const tag = "case when p.streak_days is not null then '[streak ' || p.streak_days || ']' end,\n             case when p.shared_post_id is not null then '[shared post]' end)";
    const now = fn('report_content');
    expect(now).toContain(tag);
    const back = now
      .replace(tag, "case when p.streak_days is not null then '[streak ' || p.streak_days || ']' end)")
      .split(`\n        ${ALSO}`)
      .join('');
    expect(norm(back)).toBe(norm(fnIn(sql('0033_profile_bio.sql'), 'report_content')));
  });
});

describe('posting one', () => {
  it('create_post: 0030’s, plus the post to share — and nothing else changed', () => {
    const now = fn('create_post');
    const back = now
      .replace(',\n  p_shared_post  uuid default null\n)', '\n)')
      .replace('  new_id   uuid;\n  shared   uuid;', '  new_id   uuid;')
      .replace(/  if p_shared_post is not null then[\s\S]*?\n  end if;\n\n  if p_image_path/, '  if p_image_path')
      .replace(', pet, shared_post_id\n', ', pet\n')
      .replace("coalesce(my_pet, 'potato') else null end,\n    shared\n", "coalesce(my_pet, 'potato') else null end\n");
    expect(norm(back)).toBe(norm(fnIn(sql('0030_moderation_and_rules.sql'), 'create_post')));
  });

  it('only a post the caller may see, following a repost to its original, never with its own attachment', () => {
    const now = fn('create_post');
    expect(now).toContain('select coalesce(p.shared_post_id, p.id) into shared');
    expect(now).toContain("raise exception 'That post is gone.' using errcode = 'P0002';");
    expect(now).toContain("raise exception 'One photo, set, streak or shared post per post.' using errcode = '22023';");
    // The rules first, as for every post (0030).
    expect(now.indexOf('perform public.assert_can_socialize();')).toBeLessThan(now.indexOf('if p_shared_post is not null then'));
  });

  it('drops the old signature first — two side by side and PostgREST refuses to choose', () => {
    expect(SQL.indexOf('drop function if exists public.create_post(text, text, text, integer, integer, uuid, boolean);')).toBeLessThan(
      SQL.indexOf('create or replace function public.create_post('),
    );
    expect(SQL).toContain('grant execute on function public.create_post(text, text, text, integer, integer, uuid, boolean, uuid) to authenticated;');
    expect(SQL).toContain('grant execute on function public.shared_post_visible(uuid) to authenticated;');
    expect(SQL).toContain('revoke all on function public.shared_post_visible(uuid) from public, anon;');
  });
});

// -------------------------------------------------------------- the app side --

function post(over: Partial<FeedPost> = {}): FeedPost {
  return {
    id: 'p1',
    author_id: 'a',
    author_name: 'Maria',
    author_username: 'maria',
    author_avatar: null,
    body: 'Passed!',
    audience: 'everyone',
    image_path: null,
    image_width: null,
    image_height: null,
    set_id: null,
    set_title: null,
    set_cards: 0,
    streak_days: null,
    pet: null,
    created_at: '2026-09-29T00:00:00Z',
    edited_at: null,
    comments: 0,
    ...over,
  };
}

describe('a repost, on the app’s side', () => {
  it('its original, as a post of its own; nothing for a post that shares nothing', () => {
    expect(sharedOf(post())).toBeNull();
    const repost = post({
      id: 'r1',
      body: 'Look',
      shared_post_id: 'p1',
      shared_author_id: 'a',
      shared_author_name: 'Maria',
      shared_body: 'Passed!',
      shared_audience: 'friends',
      shared_created_at: '2026-09-28T00:00:00Z',
    });
    expect(sharedOf(repost)).toMatchObject({ id: 'p1', author_name: 'Maria', body: 'Passed!', audience: 'friends' });
    expect(originalOf(repost)).toBe('p1');
    expect(originalOf(post())).toBe('p1');
  });

  it('may go without words; never with a second thing', () => {
    expect(validateDraft({ body: '', audience: 'friends', sharedPostId: 'p1' }).ok).toBe(true);
    expect(validateDraft({ body: '', audience: 'friends', sharedPostId: 'p1', photo: true }).ok).toBe(false);
  });
});

describe('a post sent in a message', () => {
  const id = '0b6f8a34-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

  it('is its link, from any origin, with anything else said kept', () => {
    const link = postLink('https://learning-app-6kk.pages.dev/', id);
    expect(link).toBe(`https://learning-app-6kk.pages.dev/post/${id}`);
    expect(postInMessage(link)).toEqual({ postId: id, rest: '' });
    expect(postInMessage(`look at this ${postLink('http://127.0.0.1:5000', id)} !`)).toEqual({ postId: id, rest: 'look at this !' });
    expect(postInMessage('no link here')).toBeNull();
    expect(postInMessage(`https://x.dev/post/${id}extra`)).toBeNull();
  });

  it('reads as "Sent a post" in the inbox and in a reply’s quote — never a link', () => {
    const link = postLink('https://x.dev', id);
    expect(messagePreview(link)).toBe('Sent a post');
    expect(messagePreview('hello')).toBe('hello');
    const c = { last_body: link, last_sender: 'me' } as Conversation;
    expect(lastLine(c, 'me')).toBe('You: Sent a post');
    expect(quoteOf('m1', link, 'Maria')?.text).toBe('Sent a post');
  });

  it('only a post everyone can see can be sent — a friends-only one would arrive as a hole', () => {
    expect(sendable({ audience: 'everyone' })).toBe(true);
    expect(sendable({ audience: 'friends' })).toBe(false);
  });

  it('a message whose post the reader may not see is not shown to them at all', () => {
    const room = readFileSync('src/ui/chat-room.tsx', 'utf8');
    expect(room).toContain('if (carried && sent.isFetched && !sent.data && !carried.rest) return null;');
    expect(room).toContain("queryFn: () => getPost(carried!.postId)");
  });
});

describe('on screen', () => {
  it('Share opens the sheet inside Nomi — never the phone’s share menu', () => {
    const list = readFileSync('src/ui/post.tsx', 'utf8');
    expect(list).not.toContain('shareLink');
    expect(list).toContain('<ShareSheet post={sharing}');
    const sheet = readFileSync('src/ui/share-sheet.tsx', 'utf8');
    expect(sheet).toContain("label: 'Share to your feed'");
    expect(sheet).toContain('router.push(`/post/new?share=${original.id}`)');
    expect(sheet).toContain('Only a post everyone can see can be sent in a message.');
  });

  it('a reported post folds away for the reporter, with a way to look again', () => {
    const list = readFileSync('src/ui/post.tsx', 'utf8');
    expect(list).toContain('if (reported.has(post.id) && !revealed.has(post.id)) {');
    expect(list).toContain("You reported this post, so it&apos;s hidden for you.");
    expect(list).toContain("void queryClient.invalidateQueries({ queryKey: ['reported-posts'] });");
    const social = readFileSync('src/data/social.ts', 'utf8');
    expect(social).toContain(".from('reports').select('target_id').eq('target_kind', 'post')");
  });

  it('a post has the heart and nothing else — no reaction row, no chips (§64); messages keep theirs', () => {
    const list = readFileSync('src/ui/post.tsx', 'utf8');
    expect(list).not.toMatch(/ReactionRow|ReactionChips/);
    expect(readFileSync('src/ui/chat-room.tsx', 'utf8')).toContain('<ReactionChips');
  });

  it('the heart pops when given — never when taken back, never with less motion asked for', () => {
    const list = readFileSync('src/ui/post.tsx', 'utf8');
    const heart = list.slice(list.indexOf('function HeartButton'), list.indexOf('function ActionIcon'));
    expect(heart).toContain('if (next && !reduce) {');
    expect(heart).toContain('Animated.spring(scale');
    // Filled at once, before the database answers; the real state once it does.
    expect(heart).toContain('const on = pending ?? mine;');
    expect(heart).toContain('useEffect(() => setPending(null), [mine, failed]);');
  });

  it('every reader of posts asks for the original through readPosts, and falls back before 0034', () => {
    const posts = readFileSync('src/data/posts.ts', 'utf8');
    expect(posts).toContain('if (!isMissingColumn(full.error)) return full;');
    for (const reader of ['export async function listFeed', 'export async function getPost', 'export async function listSaved']) {
      const body = posts.slice(posts.indexOf(reader), posts.indexOf('\n}\n', posts.indexOf(reader)));
      expect(body, reader).toContain('readPosts(');
    }
    expect(readFileSync('src/data/search.ts', 'utf8')).toContain('readPosts(');
  });
});

describe('what the Privacy Policy says is what 0034 does', () => {
  it('a repost is seen only by people who may see both, and goes with the original', () => {
    expect(privacy).toMatch(/it is seen only by people who can see both their post and yours, and it goes when you delete yours/);
  });

  it('sending, and reporting folding a post away for the reporter only', () => {
    expect(privacy).toMatch(/A post everyone can see can also be sent to a friend or a group as a message/);
    expect(privacy).toMatch(/If you report a post, it is folded away for you, with a way to look again; nobody else's view of it changes/);
  });
});
