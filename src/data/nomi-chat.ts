import { supabase, type Db } from './supabase';
import { GeminiBrowserProvider, GeminiCallError } from '../ai/gemini';
import { reasonToMessage } from '../core/ai-errors';
import { buildNomiSystemPrompt } from '../ai/prompts';
import type { AIProvider } from '../ai/provider';
import { CallQueue } from '../core/queue';
import {
  conversationTitle,
  DAILY_MESSAGE_LIMIT,
  describeRemaining,
  historyWindow,
  isAskable,
  type AssistantContext,
  type ChatTurn,
} from '../core/chat';
import { answerLocally, modelBrief, type AppSnapshot } from '../core/nomi-brain';

/**
 * Nomi's conversations: saved, listed, and answered.
 *
 * Replaces `askAssistant`, the one-question-one-answer operation D14 described.
 * The owner reversed that on 2026-09-13 — *"a chatbot, capable of everyday
 * chats … like messenger, not limited to 1 chat … just like what Claude website
 * does"* — so conversations are kept, listed and continued (NOTES §36).
 *
 * ## How a message is answered
 *
 *  1. **The student's message is saved first.** It is theirs; nothing that
 *     fails afterwards may lose it.
 *  2. **Nomi's own brain gets the first look** (`src/core/nomi-brain.ts`). A
 *     greeting, "what's my streak", "what's due" are answered from the app
 *     instantly, and spend none of the daily allowance.
 *  3. **Otherwise Gemini**, with the recent thread, the facts about the student,
 *     and whatever card or notes the screen has open — after claiming one
 *     message against the daily cap, before the call, exactly as the old
 *     assistant did.
 *
 * ## Before migration 0016
 *
 * The tables may not exist yet. That is "history is not switched on", not an
 * error: Nomi still answers, the screen keeps the conversation in memory, and
 * `conversationId` stays null so nothing pretends to have been saved.
 */

/** Its own queue, for the reason assistant.ts gave: chat must never stand in generation's way. */
const queue = new CallQueue();

export interface Conversation {
  id: string;
  title: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'nomi';
  content: string;
  created_at: string;
}

/** PostgREST: relation not in the schema cache. Postgres: undefined table. */
const MISSING_TABLE = new Set(['PGRST205', '42P01']);
const isMissingTable = (error: { code?: string } | null) => !!error && MISSING_TABLE.has(error.code ?? '');

let warnedMissing = false;
function noteMissing(): void {
  if (warnedMissing) return;
  warnedMissing = true;
  console.warn(
    '[nomi] chat history is not switched on — conversations are kept only while the app is open. ' +
      'Apply supabase/migrations/0016_profile_pictures_and_nomi_chats.sql to save them.',
  );
}

async function currentUserId(db: Db): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

/** Every conversation, newest activity first. Null when history is not switched on. */
export async function listConversations(db: Db = supabase): Promise<Conversation[] | null> {
  const { data, error } = await db
    .from('nomi_conversations')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false })
    // A history list, not an archive. The newest hundred is more than a
    // student scrolls, and bounded is the rule for tables that only grow (§30).
    .limit(100);
  if (isMissingTable(error)) {
    noteMissing();
    return null;
  }
  if (error) throw new Error(error.message);
  return (data ?? []) as Conversation[];
}

/** One conversation's messages, oldest first. */
export async function listMessages(conversationId: string, db: Db = supabase): Promise<Message[]> {
  const { data, error } = await db
    .from('nomi_messages')
    .select('id, conversation_id, role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (isMissingTable(error)) {
    noteMissing();
    return [];
  }
  if (error) throw new Error(error.message);
  return (data ?? []) as Message[];
}

/** Delete a conversation. Its messages go with it (on delete cascade). */
export async function deleteConversation(conversationId: string, db: Db = supabase): Promise<void> {
  const { error } = await db.from('nomi_conversations').delete().eq('id', conversationId);
  if (error && !isMissingTable(error)) throw new Error(error.message);
}

async function createConversation(title: string, db: Db): Promise<string | null> {
  const user_id = await currentUserId(db);
  const { data, error } = await db
    .from('nomi_conversations')
    .insert({ user_id, title })
    .select('id')
    .single();
  if (isMissingTable(error)) {
    noteMissing();
    return null;
  }
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

async function saveMessage(conversationId: string, role: 'user' | 'nomi', content: string, db: Db): Promise<void> {
  const user_id = await currentUserId(db);
  const { error } = await db
    .from('nomi_messages')
    .insert({ conversation_id: conversationId, user_id, role, content: content.slice(0, 8000) });
  if (isMissingTable(error)) {
    noteMissing();
    return;
  }
  if (error) throw new Error(error.message);
}

/**
 * Claim one Gemini reply against today's allowance, before the call.
 *
 * Unchanged from the assistant: the claim is atomic in the database
 * (migration 0010), and a missing RPC means "answer uncapped" rather than
 * refusing, because the cap is a courtesy to the quota, not a correctness rule.
 */
async function claimMessage(db: Db): Promise<number | null> {
  const { data, error } = await db.rpc('claim_chat_message', { daily_limit: DAILY_MESSAGE_LIMIT });
  if (error) {
    console.warn(`[nomi] could not claim a reply (${error.message}) — answering uncapped.`);
    return null;
  }
  return typeof data === 'number' ? data : null;
}

export type NomiReply =
  | {
      ok: true;
      text: string;
      /** Who answered: Nomi's own brain, instantly, or Gemini. */
      source: 'brain' | 'gemini';
      /** Null when history is not switched on, or saving failed. */
      conversationId: string | null;
      /** "3 more replies from me today", when worth saying. */
      note: string | null;
    }
  | {
      ok: false;
      /** `rejected`: Google refused the call for a stated reason — a bad key, quota. */
      reason: 'empty' | 'no_key' | 'limit_reached' | 'busy' | 'rejected';
      message: string;
      conversationId: string | null;
    };

export async function sendToNomi(
  input: {
    text: string;
    /** The conversation to continue, or null to start one. */
    conversationId: string | null;
    /** What is already on screen, oldest first. Works with or without saved history. */
    history: ChatTurn[];
    snapshot: AppSnapshot;
    /** The card or notes the current screen has open. */
    context: AssistantContext;
    apiKey: string;
  },
  deps: {
    db?: Db;
    provider?: Pick<AIProvider, 'chat'>;
    /**
     * How the model call is scheduled. The shared queue in production, which
     * paces calls and retries on a 10/20/40s ladder; a test passes the call
     * straight through rather than waiting a minute to see a failure.
     */
    run?: <T>(task: () => Promise<T>) => Promise<T>;
  } = {},
): Promise<NomiReply> {
  const db = deps.db ?? supabase;
  const run = deps.run ?? (<T>(task: () => Promise<T>) => queue.run(task));
  const text = input.text.trim();
  let conversationId = input.conversationId;

  if (!isAskable(text)) {
    return { ok: false, reason: 'empty', message: 'Type a message first.', conversationId };
  }

  // 1. The student's words, saved first. A failure to SAVE is logged and the
  //    conversation carries on unsaved — refusing to reply because a history
  //    row would not write is the worse failure.
  try {
    if (!conversationId) conversationId = await createConversation(conversationTitle(text), db);
    if (conversationId) await saveMessage(conversationId, 'user', text, db);
  } catch (err) {
    console.warn(`[nomi] could not save that message: ${err instanceof Error ? err.message : String(err)}`);
  }

  const keep = async (reply: string) => {
    if (!conversationId) return;
    try {
      await saveMessage(conversationId, 'nomi', reply, db);
    } catch (err) {
      console.warn(`[nomi] could not save the reply: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 2. Nomi's own brain.
  const local = answerLocally(text, input.snapshot);
  if (local) {
    await keep(local.text);
    return { ok: true, text: local.text, source: 'brain', conversationId, note: null };
  }

  // 3. Gemini.
  if (!input.apiKey) {
    return {
      ok: false,
      reason: 'no_key',
      message: 'Add your Gemini key in Settings and I can chat about anything.',
      conversationId,
    };
  }

  const remaining = await claimMessage(db);
  if (remaining !== null && remaining < 0) {
    return { ok: false, reason: 'limit_reached', message: describeRemaining(-1)!, conversationId };
  }

  try {
    const provider = deps.provider ?? new GeminiBrowserProvider(input.apiKey);
    const turns = historyWindow([...input.history, { role: 'user', text }]);
    const system = buildNomiSystemPrompt({ brief: modelBrief(input.snapshot), context: input.context });
    const answer = await run(() => provider.chat({ system, turns }));

    if (!answer) {
      return {
        ok: false,
        reason: 'busy',
        message: "I couldn't come up with a reply to that one. Try asking it differently.",
        conversationId,
      };
    }
    await keep(answer);
    return {
      ok: true,
      text: answer,
      source: 'gemini',
      conversationId,
      note: describeRemaining(remaining ?? DAILY_MESSAGE_LIMIT),
    };
  } catch (err) {
    // The claimed reply is not refunded, for the reason assistant.ts gave: the
    // failures it would cover are exactly when the quota most needs protecting.
    console.warn(`[nomi] ${err instanceof Error ? err.message : String(err)}`);
    // Say WHY when Google says why. Everything used to be "Gemini is busy",
    // and on the test account — whose stored key is a placeholder — that sent
    // the first live check hunting for an outage that was an invalid key
    // (NOTES §36). An invalid key is fixable in Settings; "busy" says wait.
    if (err instanceof GeminiCallError) {
      return { ok: false, reason: 'rejected', message: reasonToMessage(err.reason), conversationId };
    }
    return {
      ok: false,
      reason: 'busy',
      message: 'Gemini is busy right now — try again in a minute.',
      conversationId,
    };
  }
}
