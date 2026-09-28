import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  badgeLabel,
  CLOSED_CONVERSATION,
  DM_PER_MINUTE,
  inboxOrder,
  lastLine,
  seenMessageId,
  unreadTotal,
  type Conversation,
  type DirectMessage,
} from '../src/core/messages';
import { MESSAGE_MAX_LENGTH } from '../src/core/community';
import { PRIVACY_POLICY } from '../src/core/legal';

/**
 * Messages between friends (NOTES §53, migration 0028).
 *
 * The rules; the limits held to the SQL; who can read a conversation held to
 * every place that must ask; and the Privacy Policy's claims — above all that
 * these are NOT end-to-end encrypted, which it must never stop saying.
 */

const SQL = readFileSync('supabase/migrations/0028_direct_messages.sql', 'utf8').replace(/--[^\n]*/g, '');

function fn(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}(`);
  expect(start, `no function named ${name}`).toBeGreaterThan(-1);
  return SQL.slice(start, SQL.indexOf('$$;', start));
}

function view(name: string): string {
  const start = SQL.indexOf(`create view public.${name}`);
  expect(start, `no view named ${name}`).toBeGreaterThan(-1);
  return SQL.slice(start, SQL.indexOf(';', start));
}

function policy(name: string): string {
  const start = SQL.indexOf(`create policy ${name} `);
  expect(start, `no policy named ${name}`).toBeGreaterThan(-1);
  return SQL.slice(start, SQL.indexOf(';', start)).replace(/\s+/g, ' ');
}

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    person_id: 'them',
    name: 'Maria',
    username: 'maria',
    avatar: null,
    created_at: '2026-09-20T00:00:00Z',
    last_message_at: null,
    last_body: null,
    last_sender: null,
    last_at: null,
    unread: 0,
    their_read_at: null,
    can_send: true,
    ...over,
  };
}

function msg(id: string, author: string, at: string): DirectMessage {
  return { id, conversation_id: 'c1', author_id: author, body: id, created_at: at, edited_at: null };
}

// ------------------------------------------------------------------ rules --

describe('the inbox', () => {
  it('newest conversation first — an opened, empty one by when it was opened', () => {
    const ordered = inboxOrder([
      conv({ id: 'old', last_message_at: '2026-09-21T00:00:00Z' }),
      conv({ id: 'new', last_message_at: '2026-09-27T00:00:00Z' }),
      conv({ id: 'opened', created_at: '2026-09-25T00:00:00Z' }),
    ]);
    expect(ordered.map((c) => c.id)).toEqual(['new', 'opened', 'old']);
  });

  it('counts every unread message, and badges past nine as 9+', () => {
    expect(unreadTotal([conv({ unread: 2 }), conv({ unread: 0 }), conv({ unread: 5 })])).toBe(7);
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(3)).toBe('3');
    expect(badgeLabel(12)).toBe('9+');
  });

  it('says who said the last thing', () => {
    expect(lastLine(conv(), 'me')).toBe('Say hello');
    expect(lastLine(conv({ last_body: 'hi', last_sender: 'me' }), 'me')).toBe('You: hi');
    expect(lastLine(conv({ last_body: 'hey', last_sender: 'them' }), 'me')).toBe('hey');
  });
});

describe('"Seen"', () => {
  const messages = [
    msg('m1', 'me', '2026-09-28T10:00:00Z'),
    msg('m2', 'them', '2026-09-28T10:01:00Z'),
    msg('m3', 'me', '2026-09-28T10:02:00Z'),
  ];

  it('goes under my LAST message, once they have read past it — and nowhere else', () => {
    expect(seenMessageId(messages, 'me', '2026-09-28T10:05:00Z')).toBe('m3');
    expect(seenMessageId(messages, 'me', '2026-09-28T10:01:30Z')).toBeNull();
    expect(seenMessageId(messages, 'me', null)).toBeNull();
    expect(seenMessageId([msg('x', 'them', '2026-09-28T10:00:00Z')], 'me', '2026-09-28T11:00:00Z')).toBeNull();
  });
});

describe('a closed conversation says why, in words', () => {
  it('is readable, and closed because you are not friends — not broken', () => {
    expect(CLOSED_CONVERSATION).toMatch(/not friends any more/);
    expect(CLOSED_CONVERSATION).toMatch(/You can still read it/);
  });
});

// ------------------------------------------------ the database's numbers --

describe('the limits are the database’s, copied', () => {
  it('twenty a minute, and the same length as every other message', () => {
    expect(fn('send_direct_message')).toContain(`if sent >= ${DM_PER_MINUTE} then`);
    expect(SQL).toContain(`check (length(btrim(body)) between 1 and ${MESSAGE_MAX_LENGTH})`);
    expect(fn('edit_direct_message')).toContain(`length(new_body) > ${MESSAGE_MAX_LENGTH}`);
  });

  it('the same twenty-minute edit window as the Everyone room — 0025’s, not a copy', () => {
    expect(fn('edit_direct_message')).toContain('public.message_edit_window()');
    expect(fn('edit_direct_message')).toContain('edited_at = now()');
  });
});

// ---------------------------------------------------- who reads a conversation --

describe('who can read a conversation, and who can write in one', () => {
  it('its two people, across no block either way', () => {
    const readable = fn('dm_readable').replace(/\s+/g, ' ');
    expect(readable).toContain('(select auth.uid()) in (c.user_low, c.user_high)');
    expect(readable).toContain('b.blocker_id = c.user_low and b.blocked_id = c.user_high');
    expect(readable).toContain('b.blocker_id = c.user_high and b.blocked_id = c.user_low');
  });

  it('messages, read markers and both views all ask it', () => {
    expect(policy('direct_messages_select_party')).toContain('public.dm_readable(conversation_id)');
    expect(policy('conversation_reads_select_party')).toContain('public.dm_readable(conversation_id)');
    expect(view('conversation_messages')).toContain('where public.dm_readable(m.conversation_id)');
    const inbox = view('my_conversations').replace(/\s+/g, ' ');
    expect(inbox).toContain('where (select auth.uid()) in (c.user_low, c.user_high)');
    expect(inbox).toContain('b.blocker_id = c.user_low and b.blocked_id = c.user_high');
  });

  it('reactions and hiding are only on messages you can read', () => {
    for (const name of ['dm_reactions_select_party', 'dm_reactions_insert_own', 'dm_hidden_insert_own']) {
      expect(policy(name), name).toContain('exists (select 1 from public.direct_messages m where m.id = message_id)');
    }
  });

  it('only friends can start one or send in one; unfriending closes it and keeps it readable', () => {
    expect(fn('dm_can_send')).toContain("f.status = 'accepted'");
    expect(fn('send_direct_message')).toContain('if not public.dm_can_send(p_conversation) then');
    expect(fn('start_conversation')).toContain("f.status = 'accepted'");
    expect(fn('start_conversation')).toContain("raise exception 'You can only message friends.'");
    // Readable is a different, weaker check than sendable, on purpose.
    expect(fn('dm_readable')).not.toContain('friendships');
  });

  it('no insert or update policy on conversations, messages or read markers', () => {
    expect(SQL).not.toMatch(/create policy \w+ on public\.(conversations|direct_messages|conversation_reads)\s+for (insert|update|all)/);
    expect(SQL).not.toMatch(/create policy \w+ on public\.conversations\s+for delete/);
  });

  it('you unsend only your own, and "Seen" is written with the database’s clock', () => {
    expect(policy('direct_messages_delete_own')).toContain('user_id = (select auth.uid())');
    expect(fn('mark_conversation_read')).toContain('values (p_conversation, me, now())');
  });

  it('a message between friends can be reported — by somebody who can read it', () => {
    expect(SQL).toContain("check (target_kind in ('person', 'message', 'set', 'post', 'comment', 'direct_message'))");
    const report = fn('report_content');
    for (const kind of ['person', 'message', 'set', 'post', 'comment', 'direct_message']) {
      expect(report).toContain(`p_kind = '${kind}'`);
    }
    expect(report).toContain('and public.dm_readable(m.conversation_id)');
  });

  it('nothing reachable signed out, and it refuses to run before 0025–0027', () => {
    for (const name of ['start_conversation', 'send_direct_message', 'edit_direct_message', 'mark_conversation_read']) {
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon`));
      expect(fn(name), name).toContain("raise exception 'Not signed in.'");
    }
    for (const name of ['my_conversations', 'conversation_messages']) {
      expect(SQL).toMatch(new RegExp(`revoke all on public\\.${name}\\s+from anon, public`));
    }
    expect(SQL.indexOf('Apply 0025, 0026 and 0027 first')).toBeLessThan(SQL.indexOf('create table if not exists public.conversations'));
  });
});

// ----------------------------------------------------- what we promise --

const privacy = PRIVACY_POLICY.sections.flatMap((s) => s.body.flat()).join('\n');

describe('what the Privacy Policy says about messages is what the app does', () => {
  it('says plainly they are NOT end-to-end encrypted, and who can reach them', () => {
    expect(privacy).toMatch(/aren't end-to-end encrypted/);
    expect(privacy).toMatch(/the person who runs Nomi can technically reach them/);
    expect(privacy).toMatch(/messages to friends included/);
    // The warning is the migration's header — prose, so read the file as written.
    expect(readFileSync('supabase/migrations/0028_direct_messages.sql', 'utf8')).toContain(
      'NOT END-TO-END ENCRYPTED, AND THE PRIVACY POLICY SAYS SO',
    );
  });

  it('says "Seen" shows, and what unfriending and blocking do', () => {
    expect(privacy).toMatch(/They can see when you've read their messages/);
    expect(privacy).toMatch(/If you stop being friends, you can both still read the conversation, and neither of you can send more/);
    expect(privacy).toMatch(/your conversation is hidden for both of you/);
  });

  it('Delete my data removes the messages you sent — and leaves theirs, which are theirs', () => {
    expect(privacy).toMatch(/Delete my data removes[^.]*the messages you sent to friends/);
    const data = readFileSync('src/data/messages.ts', 'utf8');
    const body = data.slice(data.indexOf('export async function removeMyMessages'));
    expect(body).toContain("['direct_message_reactions', 'direct_message_hidden', 'conversation_reads', 'direct_messages']");
    expect(body).not.toContain("from('conversations')");
    expect(readFileSync('src/data/sets.ts', 'utf8')).toContain('await removeMyMessages()');
  });
});

describe('on screen', () => {
  it('Chat is an inbox: the Everyone room first, then conversations', () => {
    const community = readFileSync('app/(tabs)/community.tsx', 'utf8');
    expect(community).toMatch(/pane === 'chat' \? \(\s*<InboxPane /);
    expect(community).toContain("router.push('/messages/everyone')");
    // Conversations and groups together since NOTES §58, most recent first.
    expect(community).toContain('mergeInbox(inbox.data ?? [], groups.data ?? [])');
  });

  it('both rooms are the one ChatRoom, registered with a back control, with the ✦ kept off their Send', () => {
    const layout = readFileSync('app/_layout.tsx', 'utf8');
    expect(layout).toContain('<Stack.Screen name="messages/everyone"');
    expect(layout).toContain('<Stack.Screen name="messages/[id]"');
    expect(layout).toContain("path[0] !== 'messages'");
  });

  it('the unread badge is on Community alone, from the same count as the inbox', () => {
    const tabs = readFileSync('app/(tabs)/_layout.tsx', 'utf8');
    expect(tabs).toContain("badge={tab.name === 'community' ? badgeLabel(unread) : null}");
    expect(tabs).toContain('queryFn: () => unreadMessages()');
  });

  it('opening a conversation marks it read — a badge for what is on screen would lie', () => {
    const room = readFileSync('app/messages/[id].tsx', 'utf8');
    expect(room).toContain('void markConversationRead(conversationId)');
    expect(room).toContain("queryKey: ['dm-unread']");
  });

  it('the room never hands a send function to TanStack by reference (NOTES §53)', () => {
    // TanStack Query calls a mutation function with a second argument of its
    // own; every send function in src/data takes an optional client there. The
    // moved Everyone room sent with TanStack's context as its database, and
    // nothing arrived — the community probe caught it.
    const room = readFileSync('src/ui/chat-room.tsx', 'utf8').replace(/\/\/.*$/gm, '');
    expect(room).not.toMatch(/mutationFn:\s*actions\./);
    // With the message answered since NOTES §58 — still wrapped.
    expect(room).toContain('mutationFn: (text: string) => actions.send(text, replying?.id ?? null)');
  });

  it('a friend’s page offers a message', () => {
    expect(readFileSync('app/person/[id].tsx', 'utf8')).toContain('mutationFn: () => startConversation(personId)');
  });
});
