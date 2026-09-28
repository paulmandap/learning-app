import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROUP_MAX_PEOPLE,
  GROUP_MESSAGES_PER_MINUTE,
  GROUP_TITLE_MAX,
  GROUPS_PER_DAY,
  groupLastLine,
  inboxMatches,
  matchesQuery,
  mergeInbox,
  peopleLine,
  roomLeft,
  validateGroupTitle,
  type Group,
} from '../src/core/groups';
import { QUOTE_MAX, quoteOf, type Conversation } from '../src/core/messages';
import { PRIVACY_POLICY } from '../src/core/legal';
import { REPORT_KINDS, reportTitle } from '../src/core/social';

/**
 * Replies, and group chats (NOTES §58, migration 0032).
 *
 * The tests that matter most are the first: four functions were recreated —
 * two sends with a reply added, and the report and moderation functions with a
 * branch added — and a copy that drifted from the version it replaced (a lost
 * rate limit, a block check gone) would pass everything else here. So each is
 * held to its previous version, with only what it was meant to gain allowed to
 * differ, as tests/moderation.test.ts does for 0030's gate.
 */

const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');
const SQL = strip(readFileSync('supabase/migrations/0032_message_replies_and_group_chats.sql', 'utf8'));
const sql = (file: string) => strip(readFileSync(`supabase/migrations/${file}`, 'utf8'));
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const GATE = 'perform public.assert_can_socialize();';
const privacy = PRIVACY_POLICY.sections.flatMap((s) => s.body).flat().join(' ');

function fnIn(text: string, name: string): string {
  const start = text.indexOf(`create or replace function public.${name}(`);
  expect(start, `no function named ${name}`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('$$;', start));
}
const fn = (name: string) => fnIn(SQL, name);

function policy(name: string): string {
  const start = SQL.indexOf(`create policy ${name} `);
  expect(start, `no policy named ${name}`).toBeGreaterThan(-1);
  return norm(SQL.slice(start, SQL.indexOf(';', start)));
}

function viewIn(text: string, name: string): string {
  const start = text.indexOf(`create view public.${name}`);
  expect(start, `no view named ${name}`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf(';', start));
}

/** The column names a view selects, in order — up to its first top-level `from`. */
function columns(view: string): string[] {
  const body = view.slice(view.indexOf('select') + 6);
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && /^\sfrom\s/.test(body.slice(i, i + 6))) break;
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

// ----------------------------------------------------------------- replies --

describe('a reply is the old send, with the reply and nothing else', () => {
  it('send_global_message: 0030’s version, plus the checked reply', () => {
    const now = fn('send_global_message');
    expect(now).toContain(GATE);
    const back = now
      .replace('(message text, p_reply_to uuid default null)', '(message text)')
      .replace(/if p_reply_to is not null and not exists \(select 1 from public\.global_messages r where r\.id = p_reply_to\) then\s+raise exception 'That message is gone\.' using errcode = 'P0002';\s+end if;/, '')
      .replace('(user_id, body, reply_to)', '(user_id, body)')
      .replace('btrim(message), p_reply_to)', 'btrim(message))');
    expect(norm(back)).toBe(norm(fnIn(sql('0030_moderation_and_rules.sql'), 'send_global_message')));
  });

  it('send_direct_message: 0030’s version, plus a reply that must be in the same conversation', () => {
    const now = fn('send_direct_message');
    expect(now).toContain('r.conversation_id = p_conversation');
    const back = now
      .replace('(p_conversation uuid, p_body text, p_reply_to uuid default null)', '(p_conversation uuid, p_body text)')
      .replace(/if p_reply_to is not null and not exists \(\s+select 1 from public\.direct_messages r where r\.id = p_reply_to and r\.conversation_id = p_conversation\s+\) then\s+raise exception 'That message is gone\.' using errcode = 'P0002';\s+end if;/, '')
      .replace('(conversation_id, user_id, body, reply_to)', '(conversation_id, user_id, body)')
      .replace("btrim(coalesce(p_body, '')), p_reply_to)", "btrim(coalesce(p_body, '')))");
    expect(norm(back)).toBe(norm(fnIn(sql('0030_moderation_and_rules.sql'), 'send_direct_message')));
  });

  it('drops the old signatures first — two side by side and PostgREST refuses to choose', () => {
    expect(SQL.indexOf('drop function if exists public.send_global_message(text);')).toBeLessThan(
      SQL.indexOf('create or replace function public.send_global_message('),
    );
    expect(SQL.indexOf('drop function if exists public.send_direct_message(uuid, text);')).toBeLessThan(
      SQL.indexOf('create or replace function public.send_direct_message('),
    );
    expect(SQL).toContain('grant execute on function public.send_global_message(text, uuid) to authenticated');
    expect(SQL).toContain('grant execute on function public.send_direct_message(uuid, text, uuid) to authenticated');
  });

  it('the two rooms’ views keep every column as it was, with the reply at the end', () => {
    const chatBefore = columns(viewIn(sql('0026_friends_blocks_and_reports.sql'), 'global_chat'));
    const chatNow = columns(viewIn(SQL, 'global_chat'));
    expect(chatNow.slice(0, chatBefore.length)).toEqual(chatBefore);
    expect(chatNow.slice(chatBefore.length)).toEqual(['reply_to', 'reply_author_id', 'reply_name', 'reply_body']);

    const dmBefore = columns(viewIn(sql('0028_direct_messages.sql'), 'conversation_messages'));
    const dmNow = columns(viewIn(SQL, 'conversation_messages'));
    expect(dmNow.slice(0, dmBefore.length)).toEqual(dmBefore);
    expect(dmNow.slice(dmBefore.length)).toEqual(['reply_to', 'reply_author_id', 'reply_body']);
  });

  it('the Everyone room keeps its filters, and a quote from across a block is not shown', () => {
    const view = viewIn(SQL, 'global_chat');
    expect(view).toContain('from public.hidden_messages h');
    expect(view).toMatch(/left join public\.global_messages r\s+on r\.id = m\.reply_to\s+and not exists/);
  });

  it('reply_to is not a key — a reply outlives what it answers, and says so', () => {
    expect(SQL).toContain('alter table public.global_messages add column if not exists reply_to uuid;');
    expect(SQL).toContain('alter table public.direct_messages add column if not exists reply_to uuid;');
    expect(SQL).not.toMatch(/reply_to uuid references/);
  });
});

describe('what a reply shows of the message it answers', () => {
  it('nothing, for a message that answers nothing', () => {
    expect(quoteOf(null, null, 'Maria')).toBeNull();
  });

  it('"Message removed" when it was unsent or cannot be seen — never an empty box', () => {
    expect(quoteOf('m1', null, 'Maria')).toEqual({ who: '', text: 'Message removed', removed: true });
  });

  it('one line, cut short', () => {
    const long = 'word '.repeat(60);
    const q = quoteOf('m1', `first line\n\nsecond ${long}`, 'Maria')!;
    expect(q.text).not.toContain('\n');
    expect(q.text.length).toBeLessThanOrEqual(QUOTE_MAX);
    expect(q.text.endsWith('…')).toBe(true);
    expect(q.who).toBe('Maria');
  });
});

// ------------------------------------------------------------------ groups --

describe('0032 builds on 0028 and 0030, and says so', () => {
  it('refuses to run without them, before changing anything', () => {
    const check = SQL.indexOf("to_regprocedure('public.assert_can_socialize()') is null");
    expect(check).toBeGreaterThan(-1);
    expect(SQL).toContain("to_regclass('public.direct_messages') is null");
    expect(check).toBeLessThan(SQL.indexOf('alter table public.global_messages'));
  });
});

describe('who can see what in a group', () => {
  it('a member, since they joined, and nobody across a block — the one rule', () => {
    const f = fn('group_message_visible');
    expect(f).toContain('p_created >= public.group_member_since(p_group)');
    expect(f).toContain('(b.blocker_id = (select auth.uid()) and b.blocked_id = p_author)');
    expect(f).toContain('(b.blocker_id = p_author and b.blocked_id = (select auth.uid()))');
    expect(fn('group_member_since')).toContain('x.user_id = (select auth.uid())');
  });

  it('the messages, their reactions, reporting and the views all ask it', () => {
    expect(policy('group_messages_select_visible')).toContain('using (public.group_message_visible(group_id, user_id, created_at))');
    expect(viewIn(SQL, 'group_chat_messages')).toContain('where public.group_message_visible(m.group_id, m.user_id, m.created_at)');
    expect(viewIn(SQL, 'group_reaction_people')).toContain('public.group_message_visible(m.group_id, m.user_id, m.created_at)');
    expect(fn('report_content')).toContain('and public.group_message_visible(m.group_id, m.user_id, m.created_at);');
    // A quote from before the reader joined is not handed to them either.
    expect(viewIn(SQL, 'group_chat_messages')).toContain('and public.group_message_visible(r.group_id, r.user_id, r.created_at)');
  });

  it('who is in it: your own row from the table, everybody else through the view, minus a block', () => {
    expect(policy('group_members_select_own')).toContain('using (user_id = (select auth.uid()))');
    const view = viewIn(SQL, 'group_member_people');
    expect(view).toContain('where public.group_member_since(x.group_id) is not null');
    expect(view).toContain('(b.blocker_id = x.user_id and b.blocked_id = (select auth.uid()))');
  });

  it('the inbox counts only what the reader can see, since they joined', () => {
    const view = viewIn(SQL, 'my_groups');
    expect(view).toContain('m.created_at > coalesce(mine.read_at, mine.joined_at)');
    expect(view).toContain('from public.group_message_hidden h');
    expect(view).toContain('where mine.user_id = (select auth.uid())');
  });

  it('no insert or update policy on the three tables that carry rules — functions write them', () => {
    expect(SQL).not.toMatch(/create policy \w+ on public\.(group_chats|group_members|group_messages)\s+for (insert|update|all)/);
    for (const table of ['group_chats', 'group_members', 'group_messages', 'group_message_reactions', 'group_message_hidden']) {
      expect(SQL).toContain(`alter table public.${table} force row level security;`);
    }
  });
});

describe('making and changing a group', () => {
  it('every way to reach somebody asks the rules first (HANDOFF rule 54)', () => {
    for (const name of ['create_group', 'add_group_members', 'rename_group', 'send_group_message', 'edit_group_message']) {
      expect(fn(name), name).toContain(GATE);
    }
    // Leaving, taking somebody out and marking read reach nobody, and a
    // restricted account can always leave.
    for (const name of ['leave_group', 'remove_group_member', 'mark_group_read']) {
      expect(fn(name), name).not.toContain(GATE);
    }
  });

  it('friends only, never across a block — making one and adding to one', () => {
    for (const name of ['create_group', 'add_group_members']) {
      const f = fn(name);
      expect(f, name).toContain("where f.status = 'accepted'");
      expect(f, name).toContain('(b.blocker_id = o.id and b.blocked_id = me)');
      expect(f, name).toContain("raise exception 'You can only add friends.' using errcode = '42501';");
    }
  });

  it('the numbers are the app’s, copied', () => {
    expect(fn('create_group')).toContain(`if cardinality(others) + 1 > ${GROUP_MAX_PEOPLE} then`);
    expect(fn('add_group_members')).toContain(`if inside + cardinality(others) > ${GROUP_MAX_PEOPLE} then`);
    expect(fn('create_group')).toContain(`if made >= ${GROUPS_PER_DAY} then`);
    expect(fn('send_group_message')).toContain(`if sent >= ${GROUP_MESSAGES_PER_MINUTE} then`);
    expect(SQL).toContain(`check (length(btrim(title)) between 1 and ${GROUP_TITLE_MAX})`);
  });

  it('only its owner renames it or takes people out, and never themselves', () => {
    expect(fn('rename_group')).toContain('g.owner_id = me');
    expect(fn('remove_group_member')).toContain('g.owner_id = me');
    expect(fn('remove_group_member')).toContain('if p_user is null or p_user = me then');
  });

  it('leaving hands it to whoever has been in it longest; the last out takes the group with them', () => {
    const f = fn('leave_group');
    expect(f).toContain('order by g.joined_at, g.user_id');
    expect(f).toContain('delete from public.group_chats where id = p_group;');
  });

  it('a reply in a group answers a message in the same group', () => {
    expect(fn('send_group_message')).toContain('r.id = p_reply_to and r.group_id = p_group');
  });
});

describe('reports and moderation gain a group message, and lose nothing', () => {
  it('report_content: 0028’s, plus the group branch', () => {
    const branch = /elsif p_kind = 'group_message' then\s+select m\.user_id, m\.body\s+into owner_id, snapshot_text\s+from public\.group_messages m\s+where m\.id = p_target\s+and public\.group_message_visible\(m\.group_id, m\.user_id, m\.created_at\);/;
    expect(fn('report_content')).toMatch(branch);
    expect(norm(fn('report_content').replace(branch, ''))).toBe(norm(fnIn(sql('0028_direct_messages.sql'), 'report_content')));
  });

  it('moderate_remove: 0030’s, plus the group branch', () => {
    const branch = /elsif p_kind = 'group_message' then\s+delete from public\.group_messages where id = p_target;/;
    expect(fn('moderate_remove')).toMatch(branch);
    expect(norm(fn('moderate_remove').replace(branch, ''))).toBe(norm(fnIn(sql('0030_moderation_and_rules.sql'), 'moderate_remove')));
  });

  it('the report sheet calls it a message, like any other', () => {
    expect(REPORT_KINDS).toContain('group_message');
    expect(reportTitle('group_message')).toBe('Report this message');
  });
});

describe('the functions and views are for signed-in accounts only', () => {
  it('each revoked from the public and granted to signed-in accounts', () => {
    const signatures = [...SQL.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)/g)].map((m) => m[1]!);
    for (const name of new Set(signatures)) {
      expect(SQL, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon;`));
      expect(SQL, name).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to authenticated;`));
    }
    for (const view of ['global_chat', 'conversation_messages', 'my_groups', 'group_member_people', 'group_chat_messages', 'group_reaction_people']) {
      expect(SQL, view).toContain(`grant select on public.${view}`);
    }
  });
});

// ------------------------------------------------------------ the app side --

function conversation(id: string, at: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    person_id: `p-${id}`,
    name: 'Maria',
    username: 'maria',
    avatar: null,
    created_at: at,
    last_message_at: at,
    last_body: 'See you tomorrow',
    last_sender: 'p',
    last_at: at,
    unread: 0,
    their_read_at: null,
    can_send: true,
    ...over,
  };
}

function group(id: string, at: string | null, over: Partial<Group> = {}): Group {
  return {
    id,
    title: 'Bio Group',
    owner_id: 'me',
    i_own: true,
    created_at: '2026-09-01T00:00:00Z',
    last_message_at: at,
    joined_at: '2026-09-01T00:00:00Z',
    member_count: 4,
    last_body: null,
    last_sender: null,
    last_sender_name: null,
    last_at: at,
    unread: 0,
    ...over,
  };
}

describe('one inbox, friends and groups together', () => {
  it('most recent first, whichever kind', () => {
    const merged = mergeInbox(
      [conversation('c1', '2026-09-28T10:00:00Z'), conversation('c2', '2026-09-26T10:00:00Z')],
      [group('g1', '2026-09-27T10:00:00Z')],
    );
    expect(merged.map((e) => e.item.id)).toEqual(['c1', 'g1', 'c2']);
  });

  it('a group nobody has written in yet sorts by when you joined it', () => {
    const merged = mergeInbox([conversation('c1', '2026-09-02T00:00:00Z')], [group('g1', null, { joined_at: '2026-09-03T00:00:00Z' })]);
    expect(merged[0]!.item.id).toBe('g1');
  });

  it('search matches the name, the last line or the username — case and accents aside', () => {
    const [dm] = mergeInbox([conversation('c1', '2026-09-28T10:00:00Z', { name: 'José', username: 'jose_r' })], []);
    expect(inboxMatches(dm!, 'jose', 'José')).toBe(true);
    expect(inboxMatches(dm!, 'TOMORROW', 'José')).toBe(true);
    expect(inboxMatches(dm!, 'jose_r', 'José')).toBe(true);
    expect(inboxMatches(dm!, 'maria', 'José')).toBe(false);
    expect(matchesQuery('   ', ['anything'])).toBe(true);
  });

  it('a group’s last line says who said it — first name only, "You" for yours', () => {
    expect(groupLastLine(group('g', 'x', { last_body: 'Hi all', last_sender: 'k', last_sender_name: 'Kenji Tan' }), 'me')).toBe('Kenji: Hi all');
    expect(groupLastLine(group('g', 'x', { last_body: 'Hi all', last_sender: 'me' }), 'me')).toBe('You: Hi all');
    expect(groupLastLine(group('g', null), 'me')).toBe('4 people');
  });
});

describe('a group’s small rules, on the app’s side', () => {
  it('a name, trimmed, up to sixty characters', () => {
    expect(validateGroupTitle('  Bio  ')).toEqual({ ok: true, title: 'Bio' });
    expect(validateGroupTitle('   ').ok).toBe(false);
    expect(validateGroupTitle('x'.repeat(GROUP_TITLE_MAX + 1)).ok).toBe(false);
  });

  it('room left, never below zero', () => {
    expect(roomLeft(4)).toBe(GROUP_MAX_PEOPLE - 4);
    expect(roomLeft(GROUP_MAX_PEOPLE + 3)).toBe(0);
    expect(peopleLine(1)).toBe('1 person');
    expect(peopleLine(3)).toBe('3 people');
  });
});

describe('what the Privacy Policy says is what 0032 does', () => {
  it('a group is seen by its members only, from when they joined', () => {
    expect(privacy).toMatch(/A group is seen by the people in it and nobody else in Nomi/);
    expect(privacy).toMatch(/somebody added later doesn't see what was said earlier/);
    expect(privacy).toMatch(/Only a friend can add you to one/);
  });

  it('not end-to-end encrypted — said for groups too, and the operator’s reach names them', () => {
    expect(privacy).toMatch(/Group messages aren't end-to-end encrypted either/);
    expect(privacy).toMatch(/messages to friends included, and messages in groups/);
  });

  it('a block reaches into groups, and a group message can be reported', () => {
    expect(privacy).toMatch(/In a group you are both in, you stop seeing each other's messages/);
    expect(privacy).toMatch(/or in a group you are in\)/);
  });

  it('Delete my data takes you out of every group, and removes what you sent there', () => {
    expect(privacy).toMatch(/Delete my data removes[^.]*the messages you sent in groups and your reactions there, and it takes you out of every group/);
    const data = readFileSync('src/data/groups.ts', 'utf8');
    const body = data.slice(data.indexOf('export async function removeMyGroups'));
    expect(body).toContain("['group_message_reactions', 'group_message_hidden', 'group_messages']");
    expect(body).toContain('await leaveGroup(group_id, db)');
    expect(readFileSync('src/data/sets.ts', 'utf8')).toContain('await removeMyGroups()');
  });

  it('a reply quotes, and says when the quoted message is gone', () => {
    expect(privacy).toMatch(/A reply shows a short quote of the message it answers/);
  });
});

describe('on screen', () => {
  it('the three group screens are registered with a back control, and the ✦ kept off them', () => {
    const layout = readFileSync('app/_layout.tsx', 'utf8');
    for (const name of ['groups/new', 'groups/[id]/index', 'groups/[id]/info']) {
      expect(layout, name).toContain(`<Stack.Screen name="${name}" options={{ title: '', ...backable }} />`);
    }
    expect(layout).toContain("path[0] !== 'groups'");
  });

  it('a group is the same ChatRoom, reported as a group message', () => {
    const room = readFileSync('app/groups/[id]/index.tsx', 'utf8');
    expect(room).toContain('<ChatRoom');
    expect(room).toContain('reportKind="group_message"');
  });

  it('Reply is first in the message sheet, and not offered where nothing can be sent', () => {
    const sheet = readFileSync('src/ui/message-actions.tsx', 'utf8');
    expect(sheet).toContain("onReply ? { icon: 'reply', label: 'Reply', onPress: onReply, disabled: busy } : null");
    const room = readFileSync('src/ui/chat-room.tsx', 'utf8');
    expect(room).toMatch(/onReply=\{\s*closed\s*\?\s*undefined/);
  });

  it('nothing from src/data/groups is handed to a mutation by reference (HANDOFF rule 52)', () => {
    // The room itself is held to it by tests/messages.test.ts.
    for (const file of ['app/groups/new.tsx', 'app/groups/[id]/index.tsx', 'app/groups/[id]/info.tsx']) {
      const code = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/mutationFn: (createGroup|addGroupMembers|renameGroup|removeGroupMember|leaveGroup|sendGroupMessage)\b/);
    }
  });
});
