import type { Conversation } from './messages';
import { messagePreview } from './posts';

/**
 * Group chats — the parts decidable without a database or a screen (NOTES
 * §58, migration 0032).
 *
 * The owner took these defaults: you can only add your friends; thirty people
 * at most; whoever made it can rename it and remove people; anyone can leave;
 * a block hides that person's messages in groups. Chosen and named to him:
 * anyone in a group can add their own friends; somebody added sees from when
 * they joined; when the maker leaves, whoever has been in it longest takes
 * over.
 *
 * Every limit here is a COPY of 0032's, held to it by tests/groups.test.ts.
 */

/** People in a group, you included. Mirrors `create_group` and `add_group_members`. */
export const GROUP_MAX_PEOPLE = 30;
/** Longest group name. Mirrors `group_chats.title`'s check. */
export const GROUP_TITLE_MAX = 60;
/** New groups one person may make in a day. Mirrors `create_group`. */
export const GROUPS_PER_DAY = 10;
/** Messages a minute in groups. Mirrors `send_group_message`, and a conversation's. */
export const GROUP_MESSAGES_PER_MINUTE = 20;

/** A row of `my_groups` (0032): one group, from the reader's side. */
export interface Group {
  id: string;
  title: string;
  owner_id: string | null;
  /** Can the reader rename it and remove people? */
  i_own: boolean;
  created_at: string;
  last_message_at: string | null;
  joined_at: string;
  member_count: number;
  last_body: string | null;
  last_sender: string | null;
  last_sender_name: string | null;
  last_at: string | null;
  unread: number;
}

/** A row of `group_member_people` (0032). */
export interface GroupMember {
  group_id: string;
  user_id: string;
  name: string | null;
  username: string | null;
  avatar: string | null;
  joined_at: string;
  is_owner: boolean;
}

/** A row of `group_chat_messages` (0032). */
export interface GroupMessage {
  id: string;
  group_id: string;
  author_id: string;
  author_name: string | null;
  author_avatar: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
  reply_to: string | null;
  reply_author_id: string | null;
  reply_name: string | null;
  reply_body: string | null;
}

export type TitleCheck = { ok: true; title: string } | { ok: false; reason: string };

export function validateGroupTitle(raw: string): TitleCheck {
  const title = raw.trim();
  if (title.length === 0) return { ok: false, reason: 'Give the group a name.' };
  if (title.length > GROUP_TITLE_MAX) {
    return { ok: false, reason: `Keep the name under ${GROUP_TITLE_MAX} characters.` };
  }
  return { ok: true, title };
}

/**
 * How many more people can be added: thirty, less who is in it already.
 * Never below zero, so a full group offers nobody rather than a negative.
 */
export function roomLeft(memberCount: number): number {
  return Math.max(0, GROUP_MAX_PEOPLE - memberCount);
}

/** The line under a group's name in the inbox — who said the last thing. */
export function groupLastLine(group: Group, myId: string): string {
  if (!group.last_body) return `${group.member_count} people`;
  const line = messagePreview(group.last_body);
  if (group.last_sender === myId) return `You: ${line}`;
  const first = (group.last_sender_name ?? '').trim().split(/\s+/)[0];
  return first ? `${first}: ${line}` : line;
}

/** "4 people", under a group's name at the top of its room. */
export function peopleLine(count: number): string {
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

/**
 * One inbox: conversations with friends and groups together, most recent
 * first — the way Messenger lists them. A group or a conversation that was
 * opened and never written in sorts by when it was opened.
 */
export type InboxEntry = { kind: 'dm'; at: string; item: Conversation } | { kind: 'group'; at: string; item: Group };

export function mergeInbox(conversations: readonly Conversation[], groups: readonly Group[]): InboxEntry[] {
  const entries: InboxEntry[] = [
    ...conversations.map((c) => ({ kind: 'dm' as const, at: c.last_message_at ?? c.created_at, item: c })),
    ...groups.map((g) => ({ kind: 'group' as const, at: g.last_message_at ?? g.joined_at, item: g })),
  ];
  return entries.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.item.id < b.item.id ? -1 : 1));
}

/**
 * Does this inbox entry match what was typed in "Search messages"? Its name,
 * or the last thing said in it — case and accents aside. The inbox is on the
 * phone already, so the search is too: nothing is sent anywhere.
 */
export function inboxMatches(entry: InboxEntry, query: string, displayName: string): boolean {
  const extra = entry.kind === 'dm' ? (entry.item.username ?? '') : '';
  return matchesQuery(query, [displayName, entry.item.last_body ?? '', extra]);
}

/** Does any of these contain what was typed? Case and accents aside; nothing typed matches all. */
export function matchesQuery(query: string, texts: readonly string[]): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const q = fold(query.trim());
  if (!q) return true;
  return texts.some((s) => fold(s).includes(q));
}
