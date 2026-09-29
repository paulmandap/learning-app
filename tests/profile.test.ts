import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addRecent, BIO_MAX, countLabel, escapeLike, parseRecent, RECENT_MAX, validateBio } from '../src/core/profile';
import { PRIVACY_POLICY, TERMS_OF_USE } from '../src/core/legal';

/**
 * A bio, the new Profile, your page to others, and search (NOTES §59,
 * migration 0033).
 *
 * As in tests/groups.test.ts, the tests that matter most come first: 0033
 * recreates a view and two functions, and a copy that drifted from the version
 * it replaced — a block filter lost from `public_profiles`, a branch gone from
 * a report — would pass everything else here. So each is held to its previous
 * version, with only what it was meant to gain allowed to differ.
 */

const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');
const sql = (file: string) => strip(readFileSync(`supabase/migrations/${file}`, 'utf8'));
const SQL = sql('0033_profile_bio.sql');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const GATE = 'perform public.assert_can_socialize();';
const policyText = (doc: typeof PRIVACY_POLICY) => doc.sections.flatMap((s) => s.body).flat().join(' ');
const privacy = policyText(PRIVACY_POLICY);
const terms = policyText(TERMS_OF_USE);

function fnIn(text: string, name: string): string {
  const start = text.indexOf(`create or replace function public.${name}(`);
  expect(start, `no function named ${name}`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('$$;', start));
}
const fn = (name: string) => fnIn(SQL, name);

/** A view's text, from its `create` to its `;` — replaced in place or made fresh. */
function viewIn(text: string, name: string): string {
  const start = text.search(new RegExp(`create (or replace )?view public\\.${name}\\b`));
  expect(start, `no view named ${name}`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf(';', start));
}

/** The column names a view selects, in order — up to its first top-level `from`. */
function columns(view: string): string[] {
  const body = view.slice(view.indexOf('select') + 6, view.search(/\sfrom\s/));
  return body.split(',').map((c) => {
    const words = c.trim().split(/\s+/);
    return (words[words.length - 1] ?? '').replace(/^\w+\./, '');
  });
}

const read = (file: string) => readFileSync(file, 'utf8');

// ------------------------------------------------------------ the database --

describe('0033 builds on 0032, and says so', () => {
  it('refuses to run without it, before changing anything', () => {
    const check = SQL.indexOf("to_regprocedure('public.assert_can_socialize()') is null");
    expect(check).toBeGreaterThan(-1);
    expect(SQL).toContain("to_regclass('public.group_messages') is null");
    expect(check).toBeLessThan(SQL.indexOf('alter table public.profiles'));
  });
});

describe('the bio itself', () => {
  it('is checked by the database at the app’s length', () => {
    expect(SQL).toContain(`add column if not exists bio text check (bio is null or char_length(bio) <= ${BIO_MAX})`);
  });

  it('writing one that says something asks the rules first; clearing one never does', () => {
    const guard = fn('profiles_bio_guard');
    expect(guard).toContain(GATE);
    expect(guard).toContain("if nullif(btrim(coalesce(new.bio, '')), '') is not null");
    expect(guard).toContain("(tg_op = 'INSERT' or new.bio is distinct from old.bio)");
    // Not when nobody is signed in — the owner in the SQL editor, or a
    // moderator's function clearing it.
    expect(guard.indexOf('if (select auth.uid()) is null then')).toBeLessThan(guard.indexOf(GATE));
    expect(norm(SQL)).toContain(
      'create trigger profiles_bio_guard before insert or update of bio on public.profiles for each row execute function public.profiles_bio_guard();',
    );
  });

  it('the trigger’s function is nobody’s to call', () => {
    expect(SQL).toContain('revoke all on function public.profiles_bio_guard() from public, anon, authenticated;');
    expect(SQL).not.toMatch(/grant execute on function public\.profiles_bio_guard/);
  });
});

describe('who sees it: public_profiles, 0026’s view with the bio at the end', () => {
  it('every column as it was, then bio', () => {
    const before = columns(viewIn(sql('0026_friends_blocks_and_reports.sql'), 'public_profiles'));
    const now = columns(viewIn(SQL, 'public_profiles'));
    expect(now.slice(0, before.length)).toEqual(before);
    expect(now.slice(before.length)).toEqual(['bio']);
  });

  it('the same rows as before — still hidden across a block, both ways', () => {
    const from = (view: string) => norm(view.slice(view.search(/\sfrom\s/)));
    expect(from(viewIn(SQL, 'public_profiles'))).toBe(from(viewIn(sql('0026_friends_blocks_and_reports.sql'), 'public_profiles')));
    expect(viewIn(SQL, 'public_profiles')).toContain('with (security_barrier = true)');
  });

  it('replaced in place, never dropped — search_people reads it, and the grants stay', () => {
    expect(SQL).toContain('create or replace view public.public_profiles');
    expect(SQL).not.toMatch(/drop view[^;]*public_profiles/);
  });
});

describe('reports and moderation gain a bio, and lose nothing', () => {
  it('report_content: 0032’s, with the bio in the copy kept of a person', () => {
    const was = "select p.id, concat_ws(' ', p.display_name, '@' || p.username)";
    const now = "select p.id, concat_ws(' ', p.display_name, '@' || p.username, nullif(btrim(coalesce(p.bio, '')), ''))";
    expect(fn('report_content')).toContain(now);
    expect(norm(fn('report_content').replace(now, was))).toBe(
      norm(fnIn(sql('0032_message_replies_and_group_chats.sql'), 'report_content')),
    );
  });

  it('moderate_remove: 0032’s, plus clearing a person’s bio', () => {
    const branch = /elsif p_kind = 'person' then\s+update public\.profiles set bio = null where id = p_target;/;
    expect(fn('moderate_remove')).toMatch(branch);
    const back = fn('moderate_remove')
      .replace(branch, '')
      .replace('There is nothing to remove for that — warn or restrict them.', 'There is nothing to remove for a person — warn or restrict them.');
    expect(norm(back)).toBe(norm(fnIn(sql('0032_message_replies_and_group_chats.sql'), 'moderate_remove')));
    // Only the bio: a name, a username and a picture are for a warning.
    expect(fn('moderate_remove')).not.toMatch(/set (display_name|username|avatar)/);
  });

  it('both still for signed-in accounts only', () => {
    for (const sig of ['report_content(text, uuid, text, text)', 'moderate_remove(text, uuid)']) {
      expect(SQL).toContain(`revoke all on function public.${sig} from public, anon;`);
      expect(SQL).toContain(`grant execute on function public.${sig} to authenticated;`);
    }
  });

  it('the moderator is offered it', () => {
    expect(read('app/moderation.tsx')).toContain("kind === 'person' ? 'Clear their bio'");
  });
});

// -------------------------------------------------------------- the app side --

describe('a bio, before it is sent', () => {
  it('trimmed, spaces and line breaks run together, and empty means none', () => {
    expect(validateBio('  Nursing student.\n\n  Coffee first.  ')).toEqual({ ok: true, bio: 'Nursing student. Coffee first.' });
    expect(validateBio('   ')).toEqual({ ok: true, bio: null });
  });

  it('up to 150 characters, and a sentence saying so past that', () => {
    expect(validateBio('x'.repeat(BIO_MAX)).ok).toBe(true);
    const long = validateBio('x'.repeat(BIO_MAX + 1));
    expect(long).toEqual({ ok: false, reason: 'Keep your bio under 150 characters.' });
  });

  it('the database’s refusal of a long one reads the same', () => {
    const data = read('src/data/social.ts');
    const body = data.slice(data.indexOf('export async function saveBio'));
    expect(body).toContain("if (error?.code === '23514') throw new Error(`Keep your bio under ${BIO_MAX} characters.`);");
    // A refusal from 0033's trigger opens the rules sheet, like any social act.
    expect(body).toContain('await throwIfGated(error, db);');
  });

  it('Delete my data clears it, as the Privacy Policy says', () => {
    const data = read('src/data/social.ts');
    expect(data).toContain("await db.from('profiles').update({ bio: null }).eq('id', me);");
  });
});

describe('recent searches, on this phone only', () => {
  it('newest first, once each (case aside), at most eight', () => {
    let recent: string[] = [];
    for (const term of ['maria', 'Biology', 'MARIA']) recent = addRecent(recent, term);
    expect(recent).toEqual(['MARIA', 'Biology']);
    for (let i = 0; i < 20; i++) recent = addRecent(recent, `term ${i}`);
    expect(recent).toHaveLength(RECENT_MAX);
    expect(recent[0]).toBe('term 19');
  });

  it('a letter is not a search', () => {
    expect(addRecent(['maria'], ' a ')).toEqual(['maria']);
  });

  it('whatever was stored, strings only — never a crash', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent('["maria", 3, null, "bio"]')).toEqual(['maria', 'bio']);
  });

  it('kept per account, in the browser’s storage, and never sent anywhere', () => {
    const store = read('src/ui/recent-searches.ts');
    expect(store).toContain('nomi.recentSearches.');
    expect(store).not.toMatch(/supabase|fetch\(/);
  });
});

describe('search finds only what the reader could already reach', () => {
  it('a search for a_b means a_b', () => {
    expect(escapeLike('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });

  it('sets through public_sets, posts through feed_posts — the views with the rules', () => {
    const search = read('src/data/search.ts');
    expect(search).toContain(".from('public_sets')");
    expect(search).toContain(".from('feed_posts')");
    expect(search).not.toMatch(/\.from\('(study_sets|posts)'\)/);
    // One filter each, never `or=(…)`, which a comma in the term would break.
    expect(search).not.toContain('.or(');
    expect(search.match(/escapeLike\(term\)/g)).toHaveLength(2);
  });

  it('a count on a profile says "1 post", not "1 posts"', () => {
    expect(countLabel(1, 'Post', 'Posts')).toBe('Post');
    expect(countLabel(0, 'Post', 'Posts')).toBe('Posts');
  });
});

describe('what the Privacy Policy and Terms say is what 0033 does', () => {
  it('a bio is collected if you write one, and anyone signed in sees it on your profile', () => {
    expect(privacy).toMatch(/a short bio if you write one/);
    expect(privacy).toMatch(/which shows your name, your username, your picture, your bio if you write one/);
  });

  it('your page still never shows your friends or your streak', () => {
    expect(privacy).toMatch(/It does not show your friends, your streak or how you are doing/);
  });

  it('a report keeps a copy of the bio; the moderator can clear one; Delete my data clears it', () => {
    expect(privacy).toMatch(/the person's name, username and bio — is kept with the report/);
    expect(privacy).toMatch(/or clear a bio/);
    expect(privacy).toMatch(/It clears your name, your username, your bio and your Gemini key/);
    expect(privacy).toMatch(/your name, username and bio in Edit profile/);
  });

  it('the Terms name a bio among the things that can break them', () => {
    expect(terms).toMatch(/write a bio or send a message that harasses/);
    expect(terms).toMatch(/clear a bio/);
  });
});

describe('on screen', () => {
  it('search, Edit profile and a profile link are registered; the ✦ is kept off search', () => {
    const layout = read('app/_layout.tsx');
    expect(layout).toContain('<Stack.Screen name="search" options={{ headerShown: false }} />');
    expect(layout).toContain(`<Stack.Screen name="edit-profile" options={{ title: '', ...backable }} />`);
    expect(layout).toContain(`<Stack.Screen name="u/[username]" options={{ title: '', ...backable }} />`);
    // Since NOTES §65 the ✦ is on a set's three study screens and nowhere else,
    // so it is off this one by construction.
    expect(layout).toContain("const showAssistant = signedIn && path[0] === 'set' && ASSISTANT_SCREENS.includes(path[2] ?? '');");
    for (const file of ['app/search.tsx', 'app/edit-profile.tsx', 'app/u/[username].tsx']) {
      expect(existsSync(file), file).toBe(true);
    }
  });

  it('search is at the top of Profile and Community — not a box halfway down', () => {
    const search = "{ icon: 'search', label: 'Search', onPress: () => router.push('/search') }";
    expect(read('app/(tabs)/profile.tsx')).toContain(search);
    expect(read('app/(tabs)/community.tsx')).toContain(search);
    expect(read('app/(tabs)/profile.tsx')).not.toContain('Find people');
  });

  it('Share profile hands out the /u/ link, which asks you to sign in like every page', () => {
    expect(read('app/(tabs)/profile.tsx')).toContain('shareLink(`${name} on Nomi`, `/u/${username.data}`)');
    const page = read('app/u/[username].tsx');
    expect(page).toContain('personByUsername');
    expect(page).toContain('router.replace');
  });

  it('somebody else’s page shows posts and shared sets — never their friends or streak', () => {
    const page = read('app/person/[id].tsx');
    const stats = page.slice(page.indexOf('<StatsRow'), page.indexOf('/>', page.indexOf('<StatsRow')));
    expect(stats).toContain("'Post', 'Posts'");
    expect(stats).toContain("'Shared set', 'Shared sets'");
    expect(stats).not.toMatch(/streak|Streak|Friend/);
    expect(page).toContain('bio={who.bio}');
  });

  it('your own streak is on your own Profile only', () => {
    expect(read('app/(tabs)/profile.tsx')).toContain("label: 'Streak', icon: 'streak'");
  });

  it('nothing is handed to a mutation by reference (HANDOFF rule 52)', () => {
    for (const file of ['app/(tabs)/profile.tsx', 'app/edit-profile.tsx', 'app/search.tsx', 'app/person/[id].tsx']) {
      const code = read(file).replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(
        /mutationFn: (saveBio|saveUsername|saveDisplayName|sendFriendRequest|acceptFriendRequest|removeFriendLink|unblockPerson|blockPerson)\b/,
      );
    }
  });
});
