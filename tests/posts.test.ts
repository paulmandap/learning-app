import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUDIENCES,
  audienceDetail,
  audienceLabel,
  COMMENT_MAX_LENGTH,
  COMMENTS_PER_MINUTE,
  commentLabel,
  DEFAULT_AUDIENCE,
  FEED_PAGE,
  joinPages,
  nextCursor,
  petGrewToday,
  POST_IMAGE_LINK_SECONDS,
  POST_MAX_LENGTH,
  POSTS_PER_DAY,
  streakLine,
  validateComment,
  validateDraft,
  type FeedPost,
} from '../src/core/posts';
import { PRIVACY_POLICY } from '../src/core/legal';

/**
 * Posts, the feed, comments and reactions (NOTES §52, migration 0027).
 *
 * The rules; every limit held to the migration's text; and the one rule for
 * who sees a post held to every place that must use it — the feed, comments,
 * reactions, photos, commenting, reacting and reporting.
 */

const RAW = readFileSync('supabase/migrations/0027_posts_and_feed.sql', 'utf8');
const SQL = RAW.replace(/--[^\n]*/g, '');

function view(name: string): string {
  const start = SQL.indexOf(`create view public.${name}`);
  expect(start, `no view named ${name}`).toBeGreaterThan(-1);
  const end = SQL.indexOf(';', start);
  return SQL.slice(start, end);
}

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

function post(over: Partial<FeedPost> = {}): FeedPost {
  return {
    id: 'p1',
    author_id: 'a',
    author_name: 'Maria',
    author_username: 'maria',
    author_avatar: null,
    body: 'hello',
    audience: 'friends',
    image_path: null,
    image_width: null,
    image_height: null,
    set_id: null,
    set_title: null,
    set_cards: 0,
    streak_days: null,
    pet: null,
    created_at: '2026-09-28T00:00:00Z',
    edited_at: null,
    comments: 0,
    ...over,
  };
}

// ------------------------------------------------------------------ rules --

describe('what a post may be', () => {
  it('words, or one attachment, or both — never nothing', () => {
    expect(validateDraft({ body: '  passed my exam  ', audience: 'friends' })).toEqual({ ok: true, body: 'passed my exam' });
    expect(validateDraft({ body: '', audience: 'friends', photo: true }).ok).toBe(true);
    expect(validateDraft({ body: '', audience: 'friends', setId: 's1' }).ok).toBe(true);
    expect(validateDraft({ body: '', audience: 'friends', streak: true }).ok).toBe(true);
    expect(validateDraft({ body: '   ', audience: 'friends' }).ok).toBe(false);
  });

  it('one photo, set or streak per post, as the database allows', () => {
    const two = validateDraft({ body: 'x', audience: 'friends', photo: true, streak: true });
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.reason).toBe('One photo, set or streak per post.');
    expect(SQL).toContain('num_nonnulls(image_path, set_id, streak_days) <= 1');
    expect(SQL).toContain('length(btrim(body)) > 0 or num_nonnulls(image_path, set_id, streak_days) = 1');
  });

  it('is not too long, measured after trimming', () => {
    expect(validateDraft({ body: 'x'.repeat(POST_MAX_LENGTH), audience: 'friends' }).ok).toBe(true);
    expect(validateDraft({ body: 'x'.repeat(POST_MAX_LENGTH + 1), audience: 'friends' }).ok).toBe(false);
  });

  it('a comment is 1 to 1000 characters of something', () => {
    expect(validateComment('  nice  ')).toEqual({ ok: true, body: 'nice' });
    expect(validateComment('   ').ok).toBe(false);
    expect(validateComment('x'.repeat(COMMENT_MAX_LENGTH + 1)).ok).toBe(false);
  });

  it('says who can see it, in words, on every post', () => {
    expect(audienceLabel('friends')).toBe('Friends');
    expect(audienceLabel('everyone')).toBe('Everyone');
    expect(audienceDetail('friends')).toMatch(/Only your friends/);
    expect(audienceDetail('everyone')).toMatch(/Anyone signed in/);
    expect(commentLabel(0)).toBe('Comment');
    expect(commentLabel(1)).toBe('1 comment');
    expect(commentLabel(3)).toBe('3 comments');
  });
});

describe('the feed, a page at a time', () => {
  it('asks for more only when a whole page came back', () => {
    const full = Array.from({ length: FEED_PAGE }, (_, i) => post({ id: `p${i}`, created_at: `2026-09-28T00:00:${String(59 - i).padStart(2, '0')}Z` }));
    expect(nextCursor(full)).toEqual({ created_at: full[FEED_PAGE - 1]!.created_at, id: full[FEED_PAGE - 1]!.id });
    expect(nextCursor(full.slice(0, 3))).toBeNull();
  });

  it('shows a post once when a new one pushed it onto the next page too', () => {
    const joined = joinPages([[post({ id: 'a' }), post({ id: 'b' })], [post({ id: 'b' }), post({ id: 'c' })]]);
    expect(joined.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('pages by time AND id, so two posts in one millisecond are neither lost nor doubled', () => {
    const data = readFileSync('src/data/posts.ts', 'utf8');
    expect(data).toContain('created_at.lt.${at},and(created_at.eq.${at},id.lt.${cursor.id})');
    expect(data).toContain(".order('created_at', { ascending: false })");
    expect(data).toContain(".order('id', { ascending: false })");
  });
});

describe('a streak brag', () => {
  it('is offered on the day the pet grows — 2, 5, 10, 30 — not on day one', () => {
    for (const day of [2, 5, 10, 30]) expect(petGrewToday(day), String(day)).toBe(true);
    for (const day of [0, 1, 3, 4, 11, 31, 100]) expect(petGrewToday(day), String(day)).toBe(false);
  });

  it('says the days and the pet', () => {
    expect(streakLine(12, 'cat')).toBe('12 days in a row — my cat is large now.');
    expect(streakLine(30, 'potato')).toBe('30 days in a row — my potato is fully grown.');
    expect(streakLine(1, null)).toBe('1 day in a row — my potato is baby now.');
  });

  it('is offered only when you studied today — a streak survives a day, so yesterday\'s 5 is still 5', () => {
    const progress = readFileSync('app/(tabs)/progress.tsx', 'utf8');
    expect(progress).toContain('studiedToday && petGrewToday(streak)');
    expect(progress).toContain("router.push('/post/new?streak=1')");
  });

  it('carries the database\'s streak, never the app\'s — the app only asks for "my streak"', () => {
    expect(fn('create_post')).toContain('days := public.streak_of(me)');
    expect(fn('create_post')).toContain('p_streak       boolean');
    const data = readFileSync('src/data/posts.ts', 'utf8');
    expect(data).toContain('p_streak: !!draft.streak');
    expect(data).not.toMatch(/p_streak_days|streak_days:/);
  });

  it('counts a streak the way the app does: UTC days studied or forgiven, ending today or yesterday', () => {
    const body = fn('streak_of');
    expect(body).toContain("(now() at time zone 'utc')::date");
    expect(body).toContain('public.study_days');
    expect(body).toContain('public.streak_restores');
    expect(body).toContain('cursor_day := today - 1');
    // Nothing at all without one real day studied — restores alone are not a streak.
    expect(body.indexOf('return 0')).toBeLessThan(body.indexOf('cursor_day := today;'));
  });

  it('nobody can read anybody else\'s streak through it', () => {
    expect(SQL).toContain('revoke all on function public.streak_of(uuid) from public, anon, authenticated');
    expect(SQL).not.toMatch(/grant execute on function public\.streak_of/);
  });
});

// ------------------------------------------------ the database's numbers --

describe('the limits are the database’s, copied', () => {
  it('audiences, and friends by default — the owner’s choice', () => {
    expect(SQL).toContain(`check (audience in (${AUDIENCES.map((a) => `'${a}'`).join(', ')}))`);
    expect(SQL).toContain(`audience     text not null default '${DEFAULT_AUDIENCE}'`);
    expect(DEFAULT_AUDIENCE).toBe('friends');
    expect(fn('create_post')).toContain(`coalesce(p_audience, '${DEFAULT_AUDIENCE}')`);
  });

  it('lengths and rates', () => {
    expect(SQL).toContain(`length(body) <= ${POST_MAX_LENGTH}`);
    expect(SQL).toContain(`length(btrim(body)) between 1 and ${COMMENT_MAX_LENGTH}`);
    expect(fn('create_post')).toContain(`if posted >= ${POSTS_PER_DAY} then`);
    expect(fn('add_comment')).toContain(`if sent >= ${COMMENTS_PER_MINUTE} then`);
  });
});

// ------------------------------------------------------------ the one rule --

describe('one rule decides who sees a post, and everything uses it', () => {
  it('the author; or, across no block either way, everyone-posts and friends of friends-only posts', () => {
    const rule = fn('post_visible').replace(/\s+/g, ' ');
    expect(rule).toContain('p_author = (select auth.uid())');
    expect(rule).toContain('b.blocker_id = (select auth.uid()) and b.blocked_id = p_author');
    expect(rule).toContain('b.blocker_id = p_author and b.blocked_id = (select auth.uid())');
    expect(rule).toContain("p_audience = 'everyone'");
    expect(rule).toContain("p_audience = 'friends'");
    expect(rule).toContain("f.status = 'accepted'");
  });

  it('answers only about the caller — it cannot be asked whether two other people are friends', () => {
    expect(SQL).toContain('create or replace function public.post_visible(p_author uuid, p_audience text)');
    expect(fn('post_visible')).not.toMatch(/p_viewer|p_user/);
  });

  it('the feed, comments and reactions all filter by it', () => {
    for (const name of ['feed_posts', 'post_comment_people', 'post_reaction_people']) {
      expect(view(name), name).toContain('public.post_visible(p.user_id, p.audience)');
    }
  });

  it('and so do reacting, commenting, a post’s photo, and reporting', () => {
    expect(policy('post_reactions_insert_visible')).toContain('public.can_see_post(post_id)');
    expect(fn('add_comment')).toContain('if not public.can_see_post(p_post) then');
    expect(fn('can_see_post')).toContain('public.post_visible(p.user_id, p.audience)');
    expect(fn('can_see_post_image')).toContain('public.post_visible(p.user_id, p.audience)');
    expect(policy('post_images_read_visible')).toContain('public.can_see_post_image(name)');
    const report = fn('report_content');
    expect(report.match(/public\.post_visible\(p\.user_id, p\.audience\)/g)?.length).toBe(2);
  });

  it('comments and reactions from somebody across a block are hidden too', () => {
    for (const [name, col] of [['post_comment_people', 'c.user_id'], ['post_reaction_people', 'r.user_id']] as const) {
      const body = view(name).replace(/\s+/g, ' ');
      expect(body, name).toContain(`b.blocker_id = (select auth.uid()) and b.blocked_id = ${col}`);
      expect(body, name).toContain(`b.blocker_id = ${col} and b.blocked_id = (select auth.uid())`);
    }
  });
});

describe('what the feed may never show', () => {
  it('a set that is no longer shared — by name or otherwise', () => {
    const feed = view('feed_posts').replace(/\s+/g, ' ');
    expect(feed).toContain("left join public.study_sets s on s.id = p.set_id and s.visibility = 'public' and s.status = 'ready'");
    expect(feed).not.toContain('s.plan');
  });

  it('no Gemini key, no sign-in details, in any of the three views', () => {
    for (const name of ['feed_posts', 'post_comment_people', 'post_reaction_people']) {
      expect(view(name), name).not.toContain('gemini_api_key');
      expect(view(name), name).not.toContain('privacy_accepted_at');
      expect(view(name), name).not.toMatch(/auth\.users/);
    }
  });
});

describe('who may write what', () => {
  it('no insert or update policy on posts or comments — create_post, edit_post, add_comment', () => {
    expect(SQL).not.toMatch(/create policy \w+ on public\.(posts|post_comments)\s+for (insert|update|all)/);
  });

  it('a photo must be in your own folder and actually uploaded; a set must be shared', () => {
    const body = fn('create_post');
    expect(body).toContain('(storage.foldername(p_image_path))[1] is distinct from me::text');
    expect(body).toContain("o.bucket_id = 'post-images' and o.name = p_image_path");
    expect(body).toContain("s.visibility = 'public' and s.status = 'ready'");
  });

  it('the author of a post can remove comments on it — and the select policy lets that delete find them', () => {
    const del = policy('post_comments_delete_own_or_post_author');
    const sel = policy('post_comments_select_own_or_post_author');
    const clause = 'p.id = post_id and p.user_id = (select auth.uid())';
    expect(del).toContain(clause);
    expect(sel).toContain(clause);
  });

  it('an edit that changes the words is marked; one that changes only the audience is not', () => {
    expect(fn('edit_post')).toContain('case when new_body is distinct from old_post.body then now() else old_post.edited_at end');
  });

  it('a link to a post photo lasts ten minutes, not the hour an avatar gets (NOTES §52.7)', () => {
    // A signed link is checked when it is made, not when it is used, so it is
    // the window in which somebody who lost access can still open the photo.
    expect(POST_IMAGE_LINK_SECONDS).toBe(600);
    const data = readFileSync('src/data/posts.ts', 'utf8');
    expect(data).toContain("createSignedUrls([...paths], POST_IMAGE_LINK_SECONDS)");
    expect(data).not.toMatch(/post-images'\)\.createSignedUrls?\([^)]*60 \* 60/);
  });

  it('the photo bucket is private and takes JPEGs only, under 2 MB', () => {
    expect(SQL).toContain("values ('post-images', 'post-images', false, 2097152, array['image/jpeg'])");
    expect(SQL).not.toMatch(/public\s*=\s*true/);
  });

  it('every function refuses the signed-out, and nothing is reachable by them', () => {
    for (const name of ['create_post', 'edit_post', 'add_comment']) {
      expect(fn(name), name).toContain("raise exception 'Not signed in.'");
      expect(fn(name), name).toContain('set search_path = public, pg_temp');
    }
    for (const name of ['feed_posts', 'post_comment_people', 'post_reaction_people']) {
      expect(SQL).toMatch(new RegExp(`revoke all on public\\.${name}\\s+from anon, public`));
      expect(SQL).toMatch(new RegExp(`grant select on public\\.${name}\\s+to authenticated`));
    }
  });

  it('refuses to run before 0026, before changing anything', () => {
    expect(SQL.indexOf('Apply 0026 first')).toBeGreaterThan(-1);
    expect(SQL.indexOf('Apply 0026 first')).toBeLessThan(SQL.indexOf('create table if not exists public.posts'));
  });
});

describe('reports gain posts and comments, and lose nothing', () => {
  it('the kinds grow by name, and the three earlier branches are all still there', () => {
    expect(SQL).toContain('alter table public.reports drop constraint if exists reports_kind_check');
    expect(SQL).toContain("check (target_kind in ('person', 'message', 'set', 'post', 'comment'))");
    const body = fn('report_content');
    for (const kind of ['person', 'message', 'set', 'post', 'comment']) expect(body).toContain(`p_kind = '${kind}'`);
    expect(body).toContain("and s.visibility = 'public'");
    expect(body).toContain('left(snapshot_text, 2000)');
  });
});

// ----------------------------------------------------- what we promise --

const privacy = PRIVACY_POLICY.sections.flatMap((s) => s.body.flat()).join('\n');

describe('what the Privacy Policy says about posts is what the app does', () => {
  it('friends by default, everyone by choice, per post', () => {
    expect(privacy).toMatch(/A post is seen by your friends, or by everyone signed in to Nomi if you choose that for it/);
    expect(DEFAULT_AUDIENCE).toBe('friends');
    const composer = readFileSync('app/post/new.tsx', 'utf8');
    expect(composer).toContain('useState<Audience>(DEFAULT_AUDIENCE)');
  });

  it('a photo is shown only to the people who can see its post — and the policy says what lingers', () => {
    expect(privacy).toMatch(/A photo in a post is shown only to the people who can see that post/);
    // Measured, not assumed (NOTES §52.7): a link already handed out keeps
    // working until it lapses, so the policy says so rather than promising an
    // instant that the storage cache does not keep.
    expect(privacy).toMatch(/a photo they already had open can stay reachable to them for a short while afterwards/);
    expect(policy('post_images_read_visible')).toContain('can_see_post_image(name)');
  });

  it('Delete my data removes posts, their photos, and every comment and reaction left', () => {
    expect(privacy).toMatch(/Delete my data removes[^.]*your posts and their photos, and the comments and reactions you left/);
    const data = readFileSync('src/data/posts.ts', 'utf8');
    const body = data.slice(data.indexOf('export async function removeMyPosts'));
    expect(body).toContain("['post_comments', 'post_reactions', 'posts']");
    expect(body).toContain(".from('post-images')");
    expect(readFileSync('src/data/sets.ts', 'utf8')).toContain('await removeMyPosts()');
  });

  it('a profile does not show a streak — unless you shared it in a post', () => {
    expect(privacy).toMatch(/It does not show your friends, your streak or how you are doing — unless you share your streak in a post/);
  });
});

describe('on screen', () => {
  it('Community is Feed, Sets and Chat, with Newest and Top inside Sets', () => {
    const community = readFileSync('app/(tabs)/community.tsx', 'utf8');
    expect(community).toContain("{ key: 'feed' as const, label: 'Feed' }");
    expect(community).toContain("{ key: 'sets' as const, label: 'Sets' }");
    expect(community).toContain("{ key: 'chat' as const, label: 'Chat' }");
    expect(community).not.toContain("label: 'Top sets'");
    expect(community).toContain("useState<Pane>('feed')");
  });

  it('a set goes in a post only once it is shared', () => {
    const set = readFileSync('app/set/[id]/index.tsx', 'utf8');
    expect(set).toContain("set.status === 'ready' && visibility === 'public'");
    expect(set).toContain("label: 'Post about this set'");
  });

  it('a comment the database refused to delete is said, not swallowed', () => {
    const data = readFileSync('src/data/posts.ts', 'utf8');
    expect(data).toContain(".from('post_comments').delete().eq('id', id).select('id')");
    expect(data).toContain("That comment couldn't be removed.");
  });

  it('both new screens are registered with a back control', () => {
    const layout = readFileSync('app/_layout.tsx', 'utf8');
    expect(layout).toContain('<Stack.Screen name="post/new" options={{ title: \'\', ...backable }} />');
    expect(layout).toContain('<Stack.Screen name="post/[id]" options={{ title: \'\', ...backable }} />');
  });
});
