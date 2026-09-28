import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  atUsername,
  blockFacts,
  FRIEND_REQUESTS_PER_DAY,
  friendCountLabel,
  friendState,
  normalizeUsername,
  personName,
  reasonsFor,
  REPORT_DETAILS_MAX,
  REPORT_KINDS,
  REPORT_REASONS,
  REPORT_SENT,
  reportTitle,
  REPORTS_PER_DAY,
  RESERVED_USERNAMES,
  SEARCH_MIN,
  searchTerm,
  splitFriends,
  suggestUsername,
  USERNAME_MAX,
  USERNAME_MIN,
  validateUsername,
  type FriendLink,
} from '../src/core/social';
import { EFFECTIVE_DATE, PRIVACY_POLICY } from '../src/core/legal';
import { WHATS_NEW, whatsNewIsCurrent, whatsNewKey } from '../src/core/whats-new';

/**
 * Usernames, friends, blocking and reporting (NOTES §51, migration 0026).
 *
 * Three kinds of check, the same three `tests/community.test.ts` makes for 0021:
 * the rules themselves; every number the app shares with the database held to
 * the migration's own text; and what the views promise — including that the six
 * views 0026 recreates still promise everything they did before.
 */

const MIGRATION = readFileSync('supabase/migrations/0026_friends_blocks_and_reports.sql', 'utf8');

/** The migration without its comments — see the note on SQL_ONLY in community.test.ts. */
const SQL = MIGRATION.replace(/--[^\n]*/g, '');

function view(sql: string, name: string): string {
  const start = sql.indexOf(`create view public.${name}`);
  expect(start, `no view named ${name}`).toBeGreaterThan(-1);
  const end = sql.indexOf(';', start);
  expect(end, `view ${name} is never terminated`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

function fn(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}(`);
  expect(start, `no function named ${name}`).toBeGreaterThan(-1);
  const end = SQL.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

/** A view's column list, whitespace collapsed — everything between `select` and `from`. */
function columns(sql: string, name: string): string {
  const body = view(sql, name);
  const select = body.indexOf('select');
  const from = body.search(/\nfrom public\./);
  expect(select).toBeGreaterThan(-1);
  expect(from).toBeGreaterThan(select);
  return body.slice(select + 'select'.length, from).replace(/\s+/g, ' ').trim();
}

const older = (file: string) => readFileSync(`supabase/migrations/${file}`, 'utf8').replace(/--[^\n]*/g, '');

function link(over: Partial<FriendLink> = {}): FriendLink {
  return {
    id: 'link-1',
    person_id: 'them',
    name: 'Maria',
    username: 'maria',
    avatar: null,
    status: 'accepted',
    sent_by_me: true,
    created_at: '2026-09-20T00:00:00Z',
    accepted_at: '2026-09-21T00:00:00Z',
    ...over,
  };
}

// ------------------------------------------------------------------ rules --

describe('usernames', () => {
  it('stores what people type the way it will be stored: no @, lowercase', () => {
    expect(normalizeUsername('  @Paul_M ')).toBe('paul_m');
    expect(normalizeUsername('@@maria')).toBe('maria');
    expect(validateUsername('@Paul_M')).toEqual({ ok: true, username: 'paul_m' });
  });

  it('takes 3 to 20 letters, numbers and _, starting with a letter', () => {
    for (const good of ['abc', 'maria2026', 'paul_m', 'a'.repeat(USERNAME_MAX)]) {
      expect(validateUsername(good).ok, good).toBe(true);
    }
    for (const bad of ['', 'ab', 'a'.repeat(USERNAME_MAX + 1), '1abc', '_abc', 'pa ul', 'paul.m', 'paul-m', 'niño']) {
      expect(validateUsername(bad).ok, bad).toBe(false);
    }
  });

  it('refuses the names that would read as the app itself, however they are typed', () => {
    expect(validateUsername('nomi').ok).toBe(false);
    expect(validateUsername('@Admin').ok).toBe(false);
    expect(validateUsername('nomi_fan').ok).toBe(true);
  });

  it('says why in words', () => {
    const tooShort = validateUsername('ab');
    expect(tooShort.ok).toBe(false);
    if (!tooShort.ok) expect(tooShort.reason).toMatch(/at least 3/);
    const spaces = validateUsername('pa ul');
    if (!spaces.ok) expect(spaces.reason).toMatch(/no spaces/);
  });

  it('suggests one from a name, and only ever one that would save', () => {
    expect(suggestUsername('Paul Christian Mandap')).toBe('paul_christian_manda');
    expect(suggestUsername('Niño')).toBe('nino');
    expect(suggestUsername('  Maria  Clara ')).toBe('maria_clara');
    for (const nothing of [null, undefined, '', '123', 'Jo', 'Nomi', '!!!']) {
      expect(suggestUsername(nothing), String(nothing)).toBeNull();
    }
    for (const name of ['Paul Christian Mandap', 'Niño', 'Ana-Marie O’Brien', 'X Æ A-12']) {
      const s = suggestUsername(name);
      if (s !== null) expect(validateUsername(s).ok, name).toBe(true);
    }
  });

  it('writes an @ only where there is a username', () => {
    expect(atUsername('maria')).toBe('@maria');
    expect(atUsername(null)).toBeNull();
    expect(atUsername('')).toBeNull();
  });
});

describe('searching for people', () => {
  it('does not search on one letter, and drops the @', () => {
    expect(searchTerm('m')).toBeNull();
    expect(searchTerm('   ')).toBeNull();
    expect(searchTerm('@Ma')).toBe('ma');
    expect(searchTerm('  Maria ')).toBe('maria');
  });
});

describe('where I stand with somebody', () => {
  const none = new Set<string>();

  it('is myself on my own page, whatever else is true', () => {
    expect(friendState('me', 'me', [], none)).toBe('self');
  });

  it('reads each side of a request the right way round', () => {
    expect(friendState('me', 'them', [], none)).toBe('none');
    expect(friendState('me', 'them', [link({ status: 'pending', sent_by_me: true })], none)).toBe('sent');
    expect(friendState('me', 'them', [link({ status: 'pending', sent_by_me: false })], none)).toBe('received');
    expect(friendState('me', 'them', [link()], none)).toBe('friends');
  });

  it('is blocked when I blocked them, above anything else', () => {
    expect(friendState('me', 'them', [link()], new Set(['them']))).toBe('blocked');
  });

  it('never mistakes somebody else’s friendship for mine', () => {
    expect(friendState('me', 'someone', [link({ person_id: 'them' })], none)).toBe('none');
  });
});

describe('friends, requests, and the order each is read in', () => {
  it('splits the three, friends by name and requests newest first', () => {
    const links = [
      link({ id: 'f2', person_id: 'b', name: 'zoe' }),
      link({ id: 'f1', person_id: 'a', name: 'Ana' }),
      link({ id: 'r1', person_id: 'c', status: 'pending', sent_by_me: false, created_at: '2026-09-01T00:00:00Z' }),
      link({ id: 'r2', person_id: 'd', status: 'pending', sent_by_me: false, created_at: '2026-09-25T00:00:00Z' }),
      link({ id: 's1', person_id: 'e', status: 'pending', sent_by_me: true }),
    ];
    const { friends, received, sent } = splitFriends(links);
    expect(friends.map((l) => l.id)).toEqual(['f1', 'f2']);
    expect(received.map((l) => l.id)).toEqual(['r2', 'r1']);
    expect(sent.map((l) => l.id)).toEqual(['s1']);
  });

  it('names somebody by their name, then their username, then Someone', () => {
    expect(personName({ name: ' Maria ', username: 'maria' })).toBe('Maria');
    expect(personName({ name: null, username: 'maria' })).toBe('@maria');
    expect(personName({ name: '', username: null })).toBe('Someone');
  });

  it('counts in words', () => {
    expect(friendCountLabel(0)).toBe('No friends yet');
    expect(friendCountLabel(1)).toBe('1 friend');
    expect(friendCountLabel(12)).toBe('12 friends');
  });
});

describe('reporting', () => {
  it('offers "wrong cards" only for a set, and "pretending" only for a person', () => {
    const keys = (kind: (typeof REPORT_KINDS)[number]) => reasonsFor(kind).map((r) => r.key);
    expect(keys('set')).toContain('wrong');
    expect(keys('message')).not.toContain('wrong');
    expect(keys('person')).not.toContain('wrong');
    expect(keys('person')).toContain('impersonation');
    expect(keys('message')).not.toContain('impersonation');
    for (const kind of REPORT_KINDS) expect(keys(kind)).toContain('other');
  });

  it('names what is being reported', () => {
    expect(reportTitle('person', 'Maria')).toBe('Report Maria');
    expect(reportTitle('message')).toBe('Report this message');
    expect(reportTitle('set')).toBe('Report this set');
    expect(reportTitle('post')).toBe('Report this post');
    expect(reportTitle('comment')).toBe('Report this comment');
    expect(reportTitle('direct_message')).toBe('Report this message');
  });
});

describe('what people read uses no technical word', () => {
  it('in blocking, reporting and every reason', () => {
    const banned = /\b(RLS|policy|policies|row|column|table|database|query|API|uuid|id)\b/i;
    for (const line of [...blockFacts('Maria'), REPORT_SENT, ...REPORT_REASONS.map((r) => r.label)]) {
      expect(line).not.toMatch(banned);
    }
  });
});

// ------------------------------------------------ the database's numbers --

describe('the limits are the database’s, copied', () => {
  it('the username rule matches profiles_username_check', () => {
    expect(MIGRATION).toContain(`username ~ '^[a-z][a-z0-9_]{${USERNAME_MIN - 1},${USERNAME_MAX - 1}}$'`);
  });

  it('the reserved names are the ones the database refuses, in the same order', () => {
    const list = SQL.match(/username not in \(([\s\S]*?)\)/)?.[1] ?? '';
    const names = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(names).toEqual([...RESERVED_USERNAMES]);
  });

  it('every reserved name would otherwise be a valid username — so the list is what refuses it', () => {
    const shape = /^[a-z][a-z0-9_]{2,19}$/;
    for (const name of RESERVED_USERNAMES) expect(name, name).toMatch(shape);
  });

  it('search starts at the same length on both sides', () => {
    expect(fn('search_people')).toContain(`length(pattern.term) >= ${SEARCH_MIN}`);
  });

  it('a day’s friend requests and reports are capped where the functions cap them', () => {
    expect(fn('send_friend_request')).toContain(`if sent >= ${FRIEND_REQUESTS_PER_DAY} then`);
    expect(fn('report_content')).toContain(`if sent >= ${REPORTS_PER_DAY} then`);
  });

  it('what can be reported, why, and how much can be said about it', () => {
    // The kinds as the LATEST migration to define them has them: 0027 widened
    // 0026's three to five (NOTES §52), 0028 to six (§53), and 0032 to seven
    // with a message in a group (§58), each by name.
    const kinds = REPORT_KINDS.map((k) => `'${k}'`).join(', ');
    const latest = older('0032_message_replies_and_group_chats.sql');
    expect(latest).toContain(`check (target_kind in (${kinds}))`);
    expect(SQL).toContain("check (target_kind in ('person', 'message', 'set'))");
    const reasons = REPORT_REASONS.map((r) => `'${r.key}'`).join(', ');
    expect(SQL.replace(/\s+/g, ' ')).toContain(`reason in (${reasons})`);
    expect(SQL).toContain(`length(details) <= ${REPORT_DETAILS_MAX}`);
  });
});

// ------------------------------------------------------------- the views --

const RECREATED = [
  ['public_profiles', '0023_shared_profile_pictures.sql', 'p.id'],
  ['public_sets', '0023_shared_profile_pictures.sql', 's.user_id'],
  ['public_set_items', '0021_community.sql', 's.user_id'],
  ['global_chat', '0025_subfolders_reactions_and_edits.sql', 'm.user_id'],
  ['message_reaction_people', '0025_subfolders_reactions_and_edits.sql', 'r.user_id'],
  ['my_schedule', '0021_community.sql', 'i.user_id'],
] as const;

describe('the six views 0026 recreates', () => {
  it('keep every column they had, in the same order — public_profiles only gains username', () => {
    for (const [name, file] of RECREATED) {
      const before = columns(older(file), name);
      const after = columns(SQL, name);
      if (name === 'public_profiles') expect(after, name).toBe(`${before}, p.username`);
      else expect(after, name).toBe(before);
    }
  });

  it('hide the two people on either side of a block from each other, in every one', () => {
    for (const [name, , them] of RECREATED) {
      const body = view(SQL, name).replace(/\s+/g, ' ');
      expect(body, name).toContain('from public.blocks b');
      expect(body, name).toContain(`b.blocker_id = (select auth.uid()) and b.blocked_id = ${them}`);
      expect(body, name).toContain(`b.blocker_id = ${them} and b.blocked_id = (select auth.uid())`);
    }
  });

  it('still promise everything 0021, 0024 and 0025 held them to', () => {
    expect(view(SQL, 'public_sets')).toContain("where s.visibility = 'public'");
    expect(view(SQL, 'public_sets')).toContain("s.status = 'ready'");
    expect(view(SQL, 'public_set_items')).toContain("where s.visibility = 'public'");
    expect(view(SQL, 'public_set_items')).toContain('i.hidden = false');
    for (const leak of ['document_id', 'storage_path', 'document_pages', 'i.*']) {
      expect(view(SQL, 'public_set_items')).not.toContain(leak);
    }
    expect(view(SQL, 'public_sets')).not.toContain('s.plan');
    expect(view(SQL, 'global_chat')).toContain('from public.hidden_messages h');
    const schedule = view(SQL, 'my_schedule');
    expect(schedule).toContain('where r.user_id = (select auth.uid())');
    expect(schedule).toContain('i.hidden = false');
    expect(schedule).toContain('i.user_id = (select auth.uid())');
  });

  it('hand out no Gemini key and no sign-in details, anywhere', () => {
    for (const name of [...RECREATED.map(([n]) => n), 'my_friends', 'my_blocks']) {
      const body = view(SQL, name);
      expect(body, name).not.toContain('gemini_api_key');
      expect(body, name).not.toContain('privacy_accepted_at');
      expect(body, name).not.toMatch(/auth\.users/);
    }
  });
});

describe('the two new views are only ever about me', () => {
  it('my_friends: friendships I am part of', () => {
    expect(view(SQL, 'my_friends')).toContain('where (select auth.uid()) in (f.requester_id, f.addressee_id)');
  });

  it('my_blocks: the people I blocked, never the people who blocked me', () => {
    expect(view(SQL, 'my_blocks')).toContain('where b.blocker_id = (select auth.uid())');
  });
});

describe('who may write what', () => {
  it('no insert or update policy on any of the three new tables — writes that need a rule are functions', () => {
    expect(SQL).not.toMatch(/create policy \w+ on public\.(friendships|blocks|reports)\s+for (insert|update|all)/);
  });

  it('a block is visible to the blocker alone, and a report to the reporter alone', () => {
    expect(SQL).toMatch(/create policy blocks_select_own on public\.blocks\s+for select using \(blocker_id = \(select auth\.uid\(\)\)\)/);
    expect(SQL).toMatch(/create policy reports_select_own on public\.reports\s+for select using \(reporter_id = \(select auth\.uid\(\)\)\)/);
    // And nobody can delete a report — it is kept until it is dealt with.
    expect(SQL).not.toMatch(/on public\.reports\s+for delete/);
  });

  it('every function that writes as its owner pins its search path and refuses the signed-out', () => {
    for (const name of ['send_friend_request', 'accept_friend_request', 'block_person', 'report_content']) {
      const body = fn(name);
      expect(body, name).toContain('security definer');
      expect(body, name).toContain('set search_path = public, pg_temp');
      expect(body, name).toContain("raise exception 'Not signed in.'");
    }
  });

  it('searching runs as the person searching, so their blocks apply', () => {
    const body = fn('search_people');
    expect(body).not.toContain('security definer');
    expect(body).toContain('from public.public_profiles p');
  });

  it('nothing here is reachable signed out', () => {
    for (const name of ['send_friend_request', 'accept_friend_request', 'block_person', 'search_people']) {
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to authenticated`));
    }
    expect(SQL).toContain('revoke all on function public.report_content(text, uuid, text, text) from public, anon');
    for (const name of [...RECREATED.map(([n]) => n), 'my_friends', 'my_blocks']) {
      expect(SQL).toMatch(new RegExp(`revoke all on public\\.${name}\\s+from anon, public`));
      expect(SQL).toMatch(new RegExp(`grant select on public\\.${name}\\s+to authenticated`));
    }
  });

  it('refuses to run before 0024 and 0025, before changing anything', () => {
    const guard = SQL.indexOf('Apply 0024 and 0025 first');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(SQL.indexOf('alter table public.profiles'));
  });
});

describe('the copy of what was reported', () => {
  it('is taken by the database, never sent by the reporter', () => {
    const data = readFileSync('src/data/social.ts', 'utf8');
    const call = data.slice(data.indexOf("rpc('report_content'"), data.indexOf('});', data.indexOf("rpc('report_content'")));
    expect(call).not.toContain('snapshot');
    expect(fn('report_content')).toContain('left(snapshot_text, 2000)');
  });

  it('can only be of a set that was actually shared, so it cannot find private ones', () => {
    expect(fn('report_content')).toContain("and s.visibility = 'public'");
  });
});

// ----------------------------------------------------- what we promise --

const privacy = [PRIVACY_POLICY.intro, ...PRIVACY_POLICY.sections.flatMap((s) => s.body.flat())].join('\n');

describe('what blocking, friends and reporting are said to do is what they do', () => {
  it('"won’t be able to find you … or send you a friend request" — the views and the function', () => {
    expect(blockFacts('Maria')[0]).toMatch(/find you, see your profile or your shared sets, or send you a friend request/);
    expect(view(SQL, 'public_profiles')).toContain('from public.blocks b');
    expect(fn('send_friend_request')).toContain("raise exception 'You cannot add this person.'");
  });

  it('"if you’re friends, you won’t be any more" — block_person ends it in the same statement', () => {
    expect(blockFacts('Maria').join(' ')).toMatch(/If you're friends, you won't be any more/);
    const body = fn('block_person');
    expect(body.indexOf('delete from public.friendships')).toBeLessThan(body.indexOf('insert into public.blocks'));
  });

  it('"only you can see who your friends are" — nothing lists anybody else’s', () => {
    expect(privacy).toMatch(/Only you can see who your friends are/);
    expect(SQL).toContain('for select using ((select auth.uid()) in (requester_id, addressee_id))');
    // And a profile carries no friends, streak or progress.
    expect(columns(SQL, 'public_profiles')).toBe('p.id, p.display_name, p.avatar, p.username');
    expect(privacy).toMatch(/It does not show your friends, your streak or how you are doing/);
  });

  it('"the person you report is not told who reported them"', () => {
    expect(privacy).toMatch(/The person you report is not told who reported them/);
    expect(SQL).not.toMatch(/create view public\.\w+[\s\S]*?from public\.reports\b/);
  });

  it('Delete my data removes friends and the username, and keeps blocks and reports — as the policy says', () => {
    const data = readFileSync('src/data/social.ts', 'utf8');
    const body = data.slice(data.indexOf('export async function removeMySocialData'));
    expect(body).toContain("from('friendships').delete()");
    expect(body).toContain('username: null');
    expect(body).not.toMatch(/from\('(blocks|reports)'\)/);
    expect(readFileSync('src/data/sets.ts', 'utf8')).toContain('await removeMySocialData()');
    expect(privacy).toMatch(/Delete my data removes[^.]*your friends and friend requests/);
    expect(privacy).toMatch(/The people you blocked stay blocked/);
    expect(privacy).toMatch(/reports you made are kept until we have dealt with them/i);
  });
});

describe('the app says so when the Privacy Policy changes', () => {
  it('Home announces the policy that is in force — change one and the other must be decided too', () => {
    // The policy promises "If a change is significant, we'll let you know in the
    // app." This is the letting-know; it names the date it is about.
    expect(privacy).toMatch(/we'll let you know in the app/);
    expect(WHATS_NEW.changed).toBe(EFFECTIVE_DATE);
    expect(whatsNewIsCurrent()).toBe(true);
    expect(WHATS_NEW.policy).toContain(EFFECTIVE_DATE);
  });

  it('is on Home, and remembered per person, so a shared phone shows it to each', () => {
    const home = readFileSync('app/(tabs)/index.tsx', 'utf8');
    expect(home).toContain('<WhatsNewCard userId={userId} />');
    expect(whatsNewKey('a')).not.toBe(whatsNewKey('b'));
    expect(whatsNewKey('a')).toContain(WHATS_NEW.id);
  });

  it('never leaves Continue without the one filled button', () => {
    const card = readFileSync('src/ui/whats-new.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(card).not.toMatch(/<Button(?![^>]*variant=)/);
  });
});
