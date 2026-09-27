import { supabase, type Db } from './supabase';
import { isMissingColumn, isMissingTable } from '../core/db-errors';
import { EDIT_WINDOW_MINUTES, validateMessage } from '../core/community';
import type { Conversation, DirectMessage } from '../core/messages';
import type { Reaction } from '../core/emoji';

/**
 * Messages between friends (NOTES §53, migration 0028).
 *
 * The same shape as the rest of the social layer: the inbox and a
 * conversation's messages come from views (`my_conversations`,
 * `conversation_messages`) that name exactly the two people and hide both from
 * each other across a block; starting, sending, editing and marking read are
 * functions, because `conversations` and `direct_messages` have no insert or
 * update policy. Unsending your own, hiding one from your screen and reacting
 * are plain writes to your own rows.
 */

export class MessagesUnavailableError extends Error {
  constructor() {
    super('Messages are not switched on yet.');
    this.name = 'MessagesUnavailableError';
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

const CONVERSATION_COLUMNS =
  'id, person_id, name, username, avatar, created_at, last_message_at, last_body, last_sender, last_at, unread, their_read_at, can_send';

// ------------------------------------------------------------------ inbox --

/** Every conversation, unordered — `inboxOrder` decides, where it can be tested. */
export async function listConversations(db: Db = supabase): Promise<Conversation[]> {
  const { data, error } = await db.from('my_conversations').select(CONVERSATION_COLUMNS);
  if (unavailable(error)) throw new MessagesUnavailableError();
  if (error) throw new Error(error.message);
  return (data ?? []) as Conversation[];
}

export async function getConversation(id: string, db: Db = supabase): Promise<Conversation | null> {
  const { data, error } = await db.from('my_conversations').select(CONVERSATION_COLUMNS).eq('id', id).maybeSingle();
  if (unavailable(error)) throw new MessagesUnavailableError();
  if (error) throw new Error(error.message);
  return (data ?? null) as Conversation | null;
}

/**
 * Unread messages across the inbox, for the badge on the Community tab.
 *
 * Zero rather than an error when messages are not switched on, or the read
 * fails: a badge is a nudge, and a tab bar that throws is a broken app.
 */
export async function unreadMessages(db: Db = supabase): Promise<number> {
  const { data, error } = await db.from('my_conversations').select('unread');
  if (error) {
    if (!unavailable(error)) console.warn(`[messages] unread count: ${error.message}`);
    return 0;
  }
  return ((data ?? []) as { unread: number }[]).reduce((n, r) => n + (r.unread ?? 0), 0);
}

/** Open a conversation with a friend, or find the one there is. */
export async function startConversation(personId: string, db: Db = supabase): Promise<string> {
  const { data, error } = await db.rpc('start_conversation', { p_other: personId });
  if (unavailable(error)) throw new MessagesUnavailableError();
  if (error?.code === '42501') throw new Error('You can only message friends.');
  if (error) throw new Error(error.message);
  return data as string;
}

// ---------------------------------------------------------- a conversation --

/**
 * The most recent messages, oldest last — the Everyone room's shape
 * (`listMessages`), for the same reason: a conversation with a year in it
 * should not download all of it to show the last page.
 */
export async function listDirectMessages(conversationId: string, limit = 200, db: Db = supabase): Promise<DirectMessage[]> {
  const { data, error } = await db
    .from('conversation_messages')
    .select('id, conversation_id, author_id, body, created_at, edited_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (unavailable(error)) throw new MessagesUnavailableError();
  if (error) throw new Error(error.message);
  return ((data ?? []) as DirectMessage[]).slice().reverse();
}

export async function sendDirectMessage(conversationId: string, raw: string, db: Db = supabase): Promise<void> {
  const check = validateMessage(raw);
  if (!check.ok) throw new Error(check.reason);
  const { error } = await db.rpc('send_direct_message', { p_conversation: conversationId, p_body: check.body });
  if (unavailable(error)) throw new MessagesUnavailableError();
  if (error) {
    if (error.code === 'P0001') throw new Error('That is a lot of messages at once — give it a moment.');
    if (error.code === '42501') throw new Error("You're not friends any more, so this conversation is closed.");
    if (error.code === 'P0002') throw new Error("This conversation isn't there any more.");
    throw new Error(error.message);
  }
}

export async function editDirectMessage(id: string, raw: string, db: Db = supabase): Promise<void> {
  const check = validateMessage(raw);
  if (!check.ok) throw new Error(check.reason);
  const { error } = await db.rpc('edit_direct_message', { p_id: id, p_body: check.body });
  if (unavailable(error)) throw new MessagesUnavailableError();
  if (error) {
    if (error.code === 'P0001') throw new Error(`You can only edit a message for ${EDIT_WINDOW_MINUTES} minutes after sending it.`);
    if (error.code === 'P0002') throw new Error('That message is gone.');
    throw new Error(error.message);
  }
}

/** Take it back from both of you. Your own only (0028's delete policy). */
export async function unsendDirectMessage(id: string, db: Db = supabase): Promise<void> {
  const { data, error } = await db.from('direct_messages').delete().eq('id', id).select('id');
  if (unavailable(error)) throw new MessagesUnavailableError();
  if (error) throw new Error(error.message);
  if ((data ?? []).length === 0) throw new Error("That message couldn't be unsent.");
}

/** Off your own screen, and nobody else's. */
export async function hideDirectMessage(id: string, db: Db = supabase): Promise<void> {
  const user_id = await currentUserId(db);
  const { error } = await db.from('direct_message_hidden').insert({ user_id, message_id: id });
  if (unavailable(error)) throw new MessagesUnavailableError();
  if (error && error.code !== '23505') throw new Error(error.message);
}

/** "I have read this far." Best effort: failing to mark read is not worth an error on screen. */
export async function markConversationRead(conversationId: string, db: Db = supabase): Promise<void> {
  const { error } = await db.rpc('mark_conversation_read', { p_conversation: conversationId });
  if (error && !unavailable(error)) console.warn(`[messages] could not mark read: ${error.message}`);
}

// ----------------------------------------------------------- reactions --

/**
 * Reactions on these messages, in the chat's `Reaction` shape. There is no view
 * for names: a conversation has two people, and the screen knows both.
 */
export async function listDirectReactions(messageIds: readonly string[], db: Db = supabase): Promise<Reaction[]> {
  if (messageIds.length === 0) return [];
  const { data, error } = await db
    .from('direct_message_reactions')
    .select('message_id, user_id, emoji')
    .in('message_id', [...messageIds]);
  if (unavailable(error)) return [];
  if (error) throw new Error(error.message);
  return (data ?? []) as Reaction[];
}

export async function reactToDirectMessage(messageId: string, emoji: string, on: boolean, db: Db = supabase): Promise<void> {
  const user_id = await currentUserId(db);
  if (!on) {
    const { error } = await db
      .from('direct_message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', user_id)
      .eq('emoji', emoji);
    if (unavailable(error)) throw new MessagesUnavailableError();
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await db.from('direct_message_reactions').insert({ message_id: messageId, user_id, emoji });
  if (unavailable(error)) throw new MessagesUnavailableError();
  if (error && error.code !== '23505') throw new Error(error.message);
}

// ---------------------------------------------------------- delete my data --

/**
 * The messages I sent, my reactions, what I hid, and when I last read. The
 * conversations themselves stay — each holds the OTHER person's messages too,
 * and those are theirs to delete, not mine.
 */
export async function removeMyMessages(db: Db = supabase): Promise<void> {
  const me = await currentUserId(db);
  for (const table of ['direct_message_reactions', 'direct_message_hidden', 'conversation_reads', 'direct_messages'] as const) {
    const { error } = await db.from(table).delete().eq('user_id', me);
    if (error && !unavailable(error)) throw new Error(error.message);
  }
}
