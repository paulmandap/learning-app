import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  agoShort,
  COMMENTS_PER_MINUTE,
  HEART,
  heartsOf,
  otherReactions,
  replyingTo,
  threadComments,
  type PostComment,
} from '../src/core/posts';
import { REACTIONS } from '../src/core/emoji';
import { PRIVACY_POLICY } from '../src/core/legal';

/**
 * Replies and hearts on comments, and saved posts (NOTES §57, migration 0031).
 *
 * The same shape as tests/posts.test.ts: what the app decides on its own, and
 * the rules held to the migration's text — above all that everything new asks
 * 0027's one rule for who sees a post, and that nothing new can be read by
 * anybody but the person it belongs to.
 */

const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');
const SQL = strip(readFileSync('supabase/migrations/0031_comment_replies_likes_and_saves.sql', 'utf8'));
const OLD = strip(readFileSync('supabase/migrations/0027_posts_and_feed.sql', 'utf8'));
const privacy = PRIVACY_POLICY.sections
  .flatMap((s) => s.body)
  .flat()
  .join(' ');

function fn(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}(`);
  expect(start, `no function named ${name}`).toBeGreaterThan(-1);
  return SQL.slice(start, SQL.indexOf('$$;', start));
}

function policy(name: string): string {
  const start = SQL.indexOf(`create policy ${name} `);
  expect(start, `no policy named ${name}`).toBeGreaterThan(-1);
  return SQL.slice(start, SQL.indexOf(';', start)).replace(/\s+/g, ' ');
}

function viewIn(sql: string, name: string): string {
  const start = sql.indexOf(`create view public.${name}`);
  expect(start, `no view named ${name}`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(';', start));
}

/** The column names a view selects, in order. */
function columns(view: string): string[] {
  const list = view.slice(view.indexOf('select') + 6, view.lastIndexOf('from public.post_comments c'));
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out.map((c) => {
    const words = c.trim().split(/\s+/);
    return (words[words.length - 1] ?? '').replace(/^\w+\./, '');
  });
}

function comment(id: string, over: Partial<PostComment> = {}): PostComment {
  return {
    id,
    post_id: 'p1',
    author_id: 'a',
    author_name: 'Maria',
    author_username: 'maria',
    author_avatar: null,
    body: id,
    created_at: '2026-09-28T00:00:00Z',
    parent_id: null,
    likes: 0,
    liked: false,
    ...over,
  };
}

// --------------------------------------------------------------- the app --

describe('replies sit under the comment they answer', () => {
  it('comments oldest first, each with its replies oldest first', () => {
    const threads = threadComments([
      comment('r2', { parent_id: 'c1', created_at: '2026-09-28T00:05:00Z' }),
      comment('c2', { created_at: '2026-09-28T00:02:00Z' }),
      comment('c1', { created_at: '2026-09-28T00:01:00Z' }),
      comment('r1', { parent_id: 'c1', created_at: '2026-09-28T00:03:00Z' }),
    ]);
    expect(threads.map((t) => t.comment.id)).toEqual(['c1', 'c2']);
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(threads[1]!.replies).toEqual([]);
  });

  it('leaves out a reply to a comment the reader cannot see, rather than showing it loose', () => {
    // Its comment is hidden across a block; an answer to nothing reads as a
    // non sequitur addressed to nobody.
    const threads = threadComments([comment('c1'), comment('orphan', { parent_id: 'hidden' })]);
    expect(threads.map((t) => t.comment.id)).toEqual(['c1']);
    expect(threads.flatMap((t) => t.replies)).toEqual([]);
  });

  it('says who is being answered', () => {
    expect(replyingTo('Maria')).toBe('Replying to Maria');
  });
});

describe('a post’s heart', () => {
  it('is the first of the six reactions, and counts only hearts', () => {
    expect(HEART).toBe(REACTIONS[0]!.emoji);
    const reactions = [
      { user_id: 'me', emoji: HEART },
      { user_id: 'b', emoji: HEART },
      { user_id: 'b', emoji: '😂' },
    ];
    expect(heartsOf(reactions, 'me')).toEqual({ count: 2, mine: true });
    expect(heartsOf(reactions, 'c')).toEqual({ count: 2, mine: false });
    expect(otherReactions(reactions).map((r) => r.emoji)).toEqual(['😂']);
  });
});

describe('how long ago, the way a feed says it', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  it('now, minutes, hours, days', () => {
    expect(agoShort(now - 20_000, now)).toBe('now');
    expect(agoShort(now - 5 * 60_000, now)).toBe('5m');
    expect(agoShort(now - 2 * 3_600_000, now)).toBe('2h');
    expect(agoShort(now - 3 * 86_400_000, now)).toBe('3d');
  });

  it('a date after a week, with the year only once it is not this one', () => {
    expect(agoShort(Date.parse('2026-09-12T12:00:00Z'), now)).toBe('Sep 12');
    expect(agoShort(Date.parse('2025-09-12T12:00:00Z'), now)).toBe('Sep 12, 2025');
  });

  it('never says a negative time — a clock a little ahead is "now"', () => {
    expect(agoShort(now + 30_000, now)).toBe('now');
  });
});

// ----------------------------------------------------------- the database --

describe('0031 builds on 0027 and 0030, and says so', () => {
  it('refuses to run without them, before changing anything', () => {
    const check = SQL.indexOf("to_regprocedure('public.assert_can_socialize()') is null");
    expect(check).toBeGreaterThan(-1);
    expect(SQL).toContain("to_regclass('public.post_comments') is null");
    expect(check).toBeLessThan(SQL.indexOf('alter table public.post_comments'));
  });
});

describe('who can see a comment is 0027’s rule, plus a block with whoever wrote it', () => {
  it('can_see_comment asks post_visible and the block, both ways', () => {
    const f = fn('can_see_comment');
    expect(f).toContain('public.post_visible(p.user_id, p.audience)');
    expect(f).toContain('(b.blocker_id = (select auth.uid()) and b.blocked_id = c.user_id)');
    expect(f).toContain('(b.blocker_id = c.user_id and b.blocked_id = (select auth.uid()))');
    expect(f).toContain('security definer');
  });

  it('the comments view is 0027’s, every column as it was, with three more at the end', () => {
    const before = columns(viewIn(OLD, 'post_comment_people'));
    const now = columns(viewIn(SQL, 'post_comment_people'));
    expect(now.slice(0, before.length)).toEqual(before);
    expect(now.slice(before.length)).toEqual(['parent_id', 'likes', 'liked']);
    const view = viewIn(SQL, 'post_comment_people');
    expect(view).toContain('where public.post_visible(p.user_id, p.audience)');
    // Hearts from people across a block are not counted, as comments from them
    // are not shown.
    expect(view).toMatch(/from public\.comment_likes l\s+where l\.comment_id = c\.id\s+and not exists/);
  });

  it('the view is recreated in the same file it is dropped in, and granted again', () => {
    expect(SQL).toContain('drop view if exists public.post_comment_people;');
    expect(SQL).toContain('create view public.post_comment_people');
    expect(SQL).toContain('grant select on public.post_comment_people to authenticated');
    expect(SQL).toContain('revoke all on public.post_comment_people from anon, public');
  });
});

describe('a reply', () => {
  const f = () => fn('add_reply');

  it('asks the rules first — replying reaches another person (0030, HANDOFF rule 54)', () => {
    expect(f()).toContain('perform public.assert_can_socialize();');
    expect(f().indexOf('perform public.assert_can_socialize();')).toBeLessThan(f().indexOf('insert into'));
  });

  it('only to a comment the caller can see — and the comment above it too', () => {
    expect(f().match(/public\.can_see_comment\(target\.id\)/g)?.length).toBe(2);
    expect(f()).toContain("using errcode = 'P0002'");
  });

  it('one level deep: a reply to a reply lands under the comment above it', () => {
    expect(f()).toContain('if target.parent_id is not null then');
    expect(f()).toContain('where c.id = target.parent_id');
    expect(f()).toContain('values (target.post_id, me, btrim(coalesce(p_body, \'\')), target.id)');
  });

  it('shares add_comment’s limit — the same rows, the same number', () => {
    expect(f()).toContain(`if sent >= ${COMMENTS_PER_MINUTE} then`);
    expect(f()).toContain("c.created_at > now() - interval '1 minute'");
    expect(f()).toMatch(/from public\.post_comments c\s+where c\.user_id = me/);
  });

  it('goes with the comment it answers', () => {
    expect(SQL).toContain('parent_id uuid references public.post_comments (id) on delete cascade');
  });
});

describe('hearts and saves are your own rows, and nobody else’s to read', () => {
  it('no update policy, and select is own-only on both tables', () => {
    expect(SQL).not.toMatch(/create policy \w+ on public\.(comment_likes|post_saves)\s+for (update|all)/);
    expect(policy('comment_likes_select_own')).toContain('for select using (user_id = (select auth.uid()))');
    expect(policy('post_saves_select_own')).toContain('for select using (user_id = (select auth.uid()))');
    expect(policy('comment_likes_delete_own')).toContain('for delete using (user_id = (select auth.uid()))');
    expect(policy('post_saves_delete_own')).toContain('for delete using (user_id = (select auth.uid()))');
  });

  it('a heart only on a comment you can see; a save only on a post you can see', () => {
    expect(policy('comment_likes_insert_visible')).toContain(
      'with check (user_id = (select auth.uid()) and public.can_see_comment(comment_id))',
    );
    expect(policy('post_saves_insert_visible')).toContain(
      'with check (user_id = (select auth.uid()) and public.can_see_post(post_id))',
    );
  });

  it('row-level security is forced on both', () => {
    for (const table of ['comment_likes', 'post_saves']) {
      expect(SQL).toContain(`alter table public.${table} enable row level security;`);
      expect(SQL).toContain(`alter table public.${table} force row level security;`);
    }
  });

  it('the new functions are for signed-in accounts only', () => {
    for (const sig of ['can_see_comment(uuid)', 'add_reply(uuid, text)']) {
      expect(SQL).toContain(`revoke all on function public.${sig} from public, anon;`);
      expect(SQL).toContain(`grant execute on function public.${sig} to authenticated;`);
    }
  });
});

// ------------------------------------------------------------- the app, again --

describe('before 0031 is applied, nothing breaks', () => {
  const data = readFileSync('src/data/posts.ts', 'utf8');

  it('comments are read without the new columns, as comments with no replies or hearts', () => {
    const body = data.slice(data.indexOf('export async function listComments'));
    expect(body).toContain('if (isMissingColumn(error)) ({ data, error } = await ask(COMMENT_COLUMNS));');
    expect(body).toContain('parent_id: null, likes: 0, liked: false');
  });

  it('each new thing says it is not switched on yet, rather than failing blind', () => {
    expect(data).toContain("Replies aren't switched on yet.");
    expect(data).toContain("Hearts on comments aren't switched on yet.");
    expect(data).toContain("Saving posts isn't switched on yet.");
  });
});

describe('what the Privacy Policy says is what 0031 does', () => {
  it('hearts are counted, not named — as the view counts and the table hides', () => {
    expect(privacy).toMatch(/how many hearts each comment has — but not who gave them/);
    expect(privacy).toMatch(/Stars and hearts on comments are counted but not named/);
  });

  it('saves are private, the author included', () => {
    expect(privacy).toMatch(/The posts you save are private: nobody else, including whoever wrote them, can see that you saved one/);
  });

  it('a comment deleted takes its replies with it', () => {
    expect(privacy).toMatch(/If a comment is deleted, the replies to it go with it/);
  });
});

describe('on screen', () => {
  it('the ✦ is kept off a post’s page, where the comment box is pinned', () => {
    const layout = readFileSync('app/_layout.tsx', 'utf8');
    // Since NOTES §65 the ✦ is on a set's three study screens and nowhere else,
    // so it is off this one by construction.
    expect(layout).toContain("const showAssistant = signedIn && path[0] === 'set' && ASSISTANT_SCREENS.includes(path[2] ?? '');");
  });

  it('Saved is a tab on Profile (§59), and reads posts through the feed’s rule', () => {
    const profile = readFileSync('app/(tabs)/profile.tsx', 'utf8');
    expect(profile).toContain("{ key: 'saved' as const, label: 'Saved' }");
    expect(profile).toContain('<SavedPosts myId={userId} />');
    expect(readFileSync('src/ui/saved.tsx', 'utf8')).toContain('Only you can see what you save.');
    // The screen it was is gone, and so is its registration.
    expect(existsSync('app/saved.tsx')).toBe(false);
    expect(readFileSync('app/_layout.tsx', 'utf8')).not.toContain('name="saved"');
    const data = readFileSync('src/data/posts.ts', 'utf8');
    const body = data.slice(data.indexOf('export async function listSaved'));
    // Through `readPosts` since 0034, which asks for a repost's original too.
    expect(body).toContain("readPosts((columns) => db.from('feed_posts').select(columns).in('id', order))");
  });

  it('a heart, a save and a reply are never passed to a mutation by reference (HANDOFF rule 52)', () => {
    for (const file of ['src/ui/post.tsx', 'app/post/[id].tsx']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/mutationFn: (savePost|likeComment|addReply|addComment)\b/);
    }
  });
});
