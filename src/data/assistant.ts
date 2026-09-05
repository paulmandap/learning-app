import { supabase } from './supabase';
import { GeminiBrowserProvider } from '../ai/gemini';
import { CallQueue } from '../core/queue';
import { DAILY_MESSAGE_LIMIT, isAskable, type AssistantContext } from '../core/chat';

/**
 * The study assistant's one operation (Phase 9c, D14).
 *
 * ## Its own queue, deliberately
 *
 * `CallQueue` holds a concurrency slot for the whole task, so a chat burst
 * sharing generation's queue could occupy both slots while someone is waiting
 * for their cards. A separate instance means the assistant paces itself
 * (~7s gap, retry ladder) without ever standing in generation's way.
 *
 * The model fallback comes for free: `chat` goes through
 * `#generateContentWithFallback(LIGHT_LADDER)`, which is exactly the
 * "move to the next available model when one is exhausted" behaviour asked for,
 * already built and already measured (NOTES §6.5).
 */
const queue = new CallQueue();

export type AskResult =
  | { ok: true; answer: string; remaining: number }
  | { ok: false; reason: 'no_key' | 'empty' | 'limit_reached' | 'busy'; message: string };

/**
 * Claim one message against today's allowance.
 *
 * The claim happens BEFORE the model call, and that ordering is the point: a
 * cap enforced afterwards would let a burst of parallel questions all pass the
 * check and all spend quota. `claim_chat_message` is one atomic statement
 * (migration 0010) returning what is left, or -1 when the cap is already met.
 *
 * If the RPC is missing — 0010 not applied — this returns null and the caller
 * proceeds uncapped rather than blocking the feature entirely. The limit is a
 * courtesy to the quota, not a correctness guarantee, and refusing to answer
 * because a counter is unavailable would be the worse failure.
 */
async function claimMessage(): Promise<number | null> {
  const { data, error } = await supabase.rpc('claim_chat_message', {
    daily_limit: DAILY_MESSAGE_LIMIT,
  });

  if (error) {
    console.warn(
      `[assistant] could not claim a message (${error.message}) — answering uncapped. ` +
        'Apply supabase/migrations/0010_chat_usage.sql to enforce the daily limit.',
    );
    return null;
  }
  return typeof data === 'number' ? data : null;
}

export async function askAssistant(input: {
  question: string;
  context: AssistantContext;
  apiKey: string;
}): Promise<AskResult> {
  if (!input.apiKey) {
    return {
      ok: false,
      reason: 'no_key',
      message: 'Add your Gemini key in Settings and I can help with your notes.',
    };
  }
  if (!isAskable(input.question)) {
    return { ok: false, reason: 'empty', message: 'Ask me something about your notes.' };
  }

  const remaining = await claimMessage();
  if (remaining !== null && remaining < 0) {
    return {
      ok: false,
      reason: 'limit_reached',
      message: "That's all the questions for today — they come back tomorrow.",
    };
  }

  try {
    const provider = new GeminiBrowserProvider(input.apiKey);
    const answer = await queue.run(() =>
      provider.chat({ question: input.question, context: input.context }),
    );

    if (!answer) {
      return {
        ok: false,
        reason: 'busy',
        message: "I couldn't come up with an answer to that one. Try asking it differently.",
      };
    }
    return { ok: true, answer, remaining: remaining ?? DAILY_MESSAGE_LIMIT };
  } catch (err) {
    // The claimed message is deliberately NOT refunded. Refunding would need a
    // second write on a path that has just failed, and the failure modes it
    // would cover — a busy tier, a dropped connection — are exactly when the
    // quota most needs protecting.
    console.warn(`[assistant] ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      reason: 'busy',
      message: 'Gemini is busy right now — try again in a minute.',
    };
  }
}
