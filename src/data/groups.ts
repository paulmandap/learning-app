import { supabase, type Db } from './supabase';
import { isMissingColumn, isMissingTable } from '../core/db-errors';
import { EDIT_WINDOW_MINUTES, validateMessage } from '../core/community';
import { validateGroupTitle, type Group, type GroupMember, type GroupMessage } from '../core/groups';
import type { Reaction } from '../core/emoji';
import { throwIfGated } from './moderation';

/**
 * Group chats (NOTES §58, migration 0032).
 *
 * The shape of `src/data/messages.ts`: reads come from views (`my_groups`,
 * `group_member_people`, `group_chat_messages`, `group_reaction_people`), each
 * showing only what the reader may see — a member, since they joined, nobody
 * across a block. Everything that changes a group is a function, because
 * `group_chats`, `group_members` and `group_messages` have no insert or update
 * policy. Unsending your own, hiding and reacting are plain writes to your own
 * rows.
 */

export class GroupsUnavailableError extends Error {
  constructor() {
    super("Group chats aren't switched on yet.");
    this.name = 'GroupsUnavailableError';
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

const GROUP_COLUMNS =
  'id, title, owner_id, i_own, created_at, last_message_at, joined_at, member_count, last_body, last_sender, last_sender_name, last_at, unread';
const MESSAGE_COLUMNS =
  'id, group_id, author_id, author_name, author_avatar, body, created_at, edited_at, reply_to, reply_author_id, reply_name, reply_body';

// ------------------------------------------------------------------ inbox --

/** Every group the reader is in. Empty before 0032 — the inbox still works. */
export async function listGroups(db: Db = supabase): Promise<Group[]> {
  const { data, error } = await db.from('my_groups').select(GROUP_COLUMNS);
  if (unavailable(error)) return [];
  if (error) throw new Error(error.message);
  return (data ?? []) as Group[];
}

export async function getGroup(id: string, db: Db = supabase): Promise<Group | null> {
  const { data, error } = await db.from('my_groups').select(GROUP_COLUMNS).eq('id', id).maybeSingle();
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error) throw new Error(error.message);
  return (data ?? null) as Group | null;
}

/** Who is in it — the owner first, then by when they joined. */
export async function listGroupMembers(groupId: string, db: Db = supabase): Promise<GroupMember[]> {
  const { data, error } = await db
    .from('group_member_people')
    .select('group_id, user_id, name, username, avatar, joined_at, is_owner')
    .eq('group_id', groupId)
    .order('joined_at', { ascending: true });
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as GroupMember[];
  return [...rows.filter((m) => m.is_owner), ...rows.filter((m) => !m.is_owner)];
}

// ------------------------------------------------------- making and changing --

export async function createGroup(rawTitle: string, memberIds: readonly string[], db: Db = supabase): Promise<string> {
  const title = validateGroupTitle(rawTitle);
  if (!title.ok) throw new Error(title.reason);
  if (memberIds.length === 0) throw new Error('Pick at least one friend.');
  const { data, error } = await db.rpc('create_group', { p_title: title.title, p_members: [...memberIds] });
  await throwIfGated(error, db);
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error) {
    if (error.code === '42501') throw new Error('You can only add friends to a group.');
    if (error.code === 'P0001') throw new Error("That's a lot of new groups for one day. Try again tomorrow.");
    if (error.code === '22023') throw new Error(error.message);
    throw new Error(error.message);
  }
  return data as string;
}

/** Add friends to a group you are in. Returns how many joined. */
export async function addGroupMembers(groupId: string, memberIds: readonly string[], db: Db = supabase): Promise<number> {
  const { data, error } = await db.rpc('add_group_members', { p_group: groupId, p_members: [...memberIds] });
  await throwIfGated(error, db);
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error) {
    if (error.code === '42501') throw new Error('You can only add friends to a group.');
    if (error.code === 'P0002') throw new Error("That group isn't there any more.");
    throw new Error(error.message);
  }
  return (data as number) ?? 0;
}

export async function renameGroup(groupId: string, rawTitle: string, db: Db = supabase): Promise<void> {
  const title = validateGroupTitle(rawTitle);
  if (!title.ok) throw new Error(title.reason);
  const { error } = await db.rpc('rename_group', { p_group: groupId, p_title: title.title });
  await throwIfGated(error, db);
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error?.code === '42501') throw new Error('Only whoever made the group can rename it.');
  if (error) throw new Error(error.message);
}

export async function removeGroupMember(groupId: string, userId: string, db: Db = supabase): Promise<void> {
  const { error } = await db.rpc('remove_group_member', { p_group: groupId, p_user: userId });
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error?.code === '42501') throw new Error('Only whoever made the group can remove people.');
  if (error) throw new Error(error.message);
}

/** Leave. If you made it, whoever has been in it longest takes over. */
export async function leaveGroup(groupId: string, db: Db = supabase): Promise<void> {
  const { error } = await db.rpc('leave_group', { p_group: groupId });
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error && error.code !== 'P0002') throw new Error(error.message);
}

// ----------------------------------------------------------- the messages --

/** The most recent messages the reader may see, oldest last — a conversation's shape. */
export async function listGroupMessages(groupId: string, limit = 200, db: Db = supabase): Promise<GroupMessage[]> {
  const { data, error } = await db
    .from('group_chat_messages')
    .select(MESSAGE_COLUMNS)
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error) throw new Error(error.message);
  return ((data ?? []) as GroupMessage[]).slice().reverse();
}

export async function sendGroupMessage(
  groupId: string,
  raw: string,
  replyTo: string | null = null,
  db: Db = supabase,
): Promise<void> {
  const check = validateMessage(raw);
  if (!check.ok) throw new Error(check.reason);
  const { error } = await db.rpc('send_group_message', { p_group: groupId, p_body: check.body, p_reply_to: replyTo });
  await throwIfGated(error, db);
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error) {
    if (error.code === 'P0001') throw new Error('That is a lot of messages at once — give it a moment.');
    if (error.code === 'P0002') throw new Error("This group isn't there any more, or the message you're replying to is gone.");
    throw new Error(error.message);
  }
}

export async function editGroupMessage(id: string, raw: string, db: Db = supabase): Promise<void> {
  const check = validateMessage(raw);
  if (!check.ok) throw new Error(check.reason);
  const { error } = await db.rpc('edit_group_message', { p_id: id, p_body: check.body });
  await throwIfGated(error, db);
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error) {
    if (error.code === 'P0001') throw new Error(`You can only edit a message for ${EDIT_WINDOW_MINUTES} minutes after sending it.`);
    if (error.code === 'P0002') throw new Error('That message is gone.');
    throw new Error(error.message);
  }
}

/** Take it back from everybody in the group. Your own only (0032's delete policy). */
export async function unsendGroupMessage(id: string, db: Db = supabase): Promise<void> {
  const { data, error } = await db.from('group_messages').delete().eq('id', id).select('id');
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error) throw new Error(error.message);
  if ((data ?? []).length === 0) throw new Error("That message couldn't be unsent.");
}

/** Off your own screen, and nobody else's. */
export async function hideGroupMessage(id: string, db: Db = supabase): Promise<void> {
  const user_id = await currentUserId(db);
  const { error } = await db.from('group_message_hidden').insert({ user_id, message_id: id });
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error && error.code !== '23505') throw new Error(error.message);
}

/** Best effort, like a conversation's: failing to mark read is not worth an error on screen. */
export async function markGroupRead(groupId: string, db: Db = supabase): Promise<void> {
  const { error } = await db.rpc('mark_group_read', { p_group: groupId });
  if (error && !unavailable(error)) console.warn(`[groups] could not mark read: ${error.message}`);
}

// ----------------------------------------------------------- reactions --

/** Reactions on these messages, named — a group has many people, unlike a conversation. */
export async function listGroupReactions(messageIds: readonly string[], db: Db = supabase): Promise<Reaction[]> {
  if (messageIds.length === 0) return [];
  const { data, error } = await db
    .from('group_reaction_people')
    .select('message_id, user_id, name, emoji')
    .in('message_id', [...messageIds]);
  if (unavailable(error)) return [];
  if (error) throw new Error(error.message);
  return (data ?? []) as Reaction[];
}

export async function reactToGroupMessage(messageId: string, emoji: string, on: boolean, db: Db = supabase): Promise<void> {
  const user_id = await currentUserId(db);
  const { error } = on
    ? await db.from('group_message_reactions').insert({ message_id: messageId, user_id, emoji })
    : await db
        .from('group_message_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', user_id)
        .eq('emoji', emoji);
  if (unavailable(error)) throw new GroupsUnavailableError();
  if (error && error.code !== '23505') throw new Error(error.message);
}

// ---------------------------------------------------------- delete my data --

/**
 * The messages I sent to groups, my reactions there, what I hid — and every
 * group I am in, left. Leaving hands a group I made to whoever has been in it
 * longest, and a group nobody is left in is gone. Nothing of the OTHER
 * members' is touched: their messages are theirs.
 */
export async function removeMyGroups(db: Db = supabase): Promise<void> {
  const me = await currentUserId(db);
  for (const table of ['group_message_reactions', 'group_message_hidden', 'group_messages'] as const) {
    const { error } = await db.from(table).delete().eq('user_id', me);
    if (error && !unavailable(error)) throw new Error(error.message);
  }
  const { data, error } = await db.from('group_members').select('group_id').eq('user_id', me);
  if (error) {
    if (unavailable(error)) return;
    throw new Error(error.message);
  }
  for (const { group_id } of (data ?? []) as { group_id: string }[]) await leaveGroup(group_id, db);
}
