/**
 * Messages between friends — the parts decidable without a database or a
 * screen (NOTES §53, migration 0028).
 *
 * Every limit here is a COPY of 0028's, held to it by `tests/messages.test.ts`.
 * The length and the edit window are the Everyone room's own (0021, 0025): a
 * message is a message, wherever it is sent, and `validateMessage` in
 * `src/core/community.ts` is the one check for all of them.
 */

/**
 * How often an open room asks for new messages — the Everyone room and a
 * conversation alike.
 *
 * Polling, not Supabase's realtime channels — the reasoning in NOTES §46.5
 * stands: a query with an interval is the same path as every other read in the
 * app, and it stops when the screen is not on top, so a phone in a pocket asks
 * for nothing. If four seconds ever reads as broken, that is the measurement
 * that reopens it.
 */
export const CHAT_POLL_MS = 4000;

/** How often the inbox and the unread badge look for new messages. */
export const INBOX_POLL_MS = 20_000;

/** Twenty a minute. Mirrors `send_direct_message` (0028). */
export const DM_PER_MINUTE = 20;

/** A row of `my_conversations` (0028): one conversation, seen from my side. */
export interface Conversation {
  id: string;
  /** The other person. */
  person_id: string;
  name: string | null;
  username: string | null;
  avatar: string | null;
  created_at: string;
  last_message_at: string | null;
  last_body: string | null;
  last_sender: string | null;
  last_at: string | null;
  unread: number;
  /** When they last had it open — "Seen". Null before they ever have. */
  their_read_at: string | null;
  /** False once you are not friends: readable, and closed. */
  can_send: boolean;
}

/** A row of `conversation_messages` (0028). */
export interface DirectMessage {
  id: string;
  conversation_id: string;
  author_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
}

/**
 * The inbox, most recent first. A conversation that was opened and never
 * written in sorts by when it was opened, so "New message" to a friend puts
 * them at the top rather than at the bottom under a year of others.
 */
export function inboxOrder(conversations: readonly Conversation[]): Conversation[] {
  const when = (c: Conversation) => c.last_message_at ?? c.created_at;
  return conversations.slice().sort((a, b) => {
    const x = when(a);
    const y = when(b);
    if (x !== y) return x < y ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Every unread message across the inbox — the number on the Community tab. */
export function unreadTotal(conversations: readonly Conversation[]): number {
  return conversations.reduce((n, c) => n + Math.max(0, c.unread), 0);
}

/** "9+" past nine: a badge is a nudge, not a ledger. */
export function badgeLabel(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? '9+' : String(count);
}

/** The line under a name in the inbox. */
export function lastLine(conversation: Conversation, myId: string): string {
  if (!conversation.last_body) return 'Say hello';
  return conversation.last_sender === myId ? `You: ${conversation.last_body}` : conversation.last_body;
}

/**
 * Which of my messages says "Seen" — the last one I sent, once they have read
 * past it — or null.
 *
 * Only ever one, under the last: "Seen" on every message is a column of the
 * same word, and the last one is the only one that tells you anything.
 */
export function seenMessageId(
  messages: readonly DirectMessage[],
  myId: string,
  theirReadAt: string | null,
): string | null {
  if (!theirReadAt) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.author_id !== myId) continue;
    return Date.parse(theirReadAt) >= Date.parse(m.created_at) ? m.id : null;
  }
  return null;
}

/** What the box says when you cannot send — the conversation is closed, not broken. */
export const CLOSED_CONVERSATION =
  "You're not friends any more, so this conversation is closed. You can still read it.";
