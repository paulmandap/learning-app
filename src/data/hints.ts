import { supabase, type Db } from './supabase';
import { claimMessage } from './nomi-chat';
import { GeminiBrowserProvider, GeminiCallError } from '../ai/gemini';
import { reasonToMessage } from '../core/ai-errors';
import { CallQueue } from '../core/queue';
import { describeRemaining } from '../core/chat';
import { givesAway } from '../core/hints';

/**
 * The bigger hint, from Gemini, for a student stuck on a card (NOTES §69).
 *
 * The quick clue (`src/core/hints.ts`) costs nothing and needs nothing. This
 * one is a model call, so it goes the way a chat message does: a key, one of
 * the day's chat replies claimed first (the same allowance — a hint is Nomi
 * talking), the chat's limits (15 s a model, 45 s in all, NOTES §67), and one
 * attempt. What comes back is checked before it is shown: a hint holding the
 * answer is no hint.
 */

/** Its own queue, one attempt: the student is sitting on the card. */
const queue = new CallQueue({ maxAttempts: 1 });

export type HintReply = { ok: true; hint: string; note: string | null } | { ok: false; message: string };

export async function askForHint(
  input: {
    question: string;
    answer: string;
    source: string;
    apiKey: string;
  },
  deps: {
    db?: Db;
    provider?: Pick<GeminiBrowserProvider, 'hint'>;
    run?: <T>(task: () => Promise<T>) => Promise<T>;
  } = {},
): Promise<HintReply> {
  if (!input.apiKey) return { ok: false, message: 'Add your Gemini key in Settings and I can give bigger hints.' };

  const remaining = await claimMessage(deps.db ?? supabase);
  if (remaining !== null && remaining < 0) {
    return { ok: false, message: "That's all my replies for today — they come back tomorrow. The quick clue still works." };
  }

  const provider = deps.provider ?? new GeminiBrowserProvider(input.apiKey);
  const run = deps.run ?? (<T>(task: () => Promise<T>) => queue.run(task));
  try {
    const hint = await run(() =>
      provider.hint({ question: input.question, answer: input.answer, source: input.source }),
    );
    // The prompt asks for no answer; this checks. Shown, it would spoil the
    // card the student asked for help with rather than for the answer.
    if (!hint || givesAway(hint, input.answer)) {
      if (hint) console.warn(`[hint] gave the answer away, not shown: ${JSON.stringify(hint)}`);
      return { ok: false, message: "I can't think of a hint that doesn't give it away. Have another go, or turn it over." };
    }
    return { ok: true, hint, note: describeRemaining(remaining ?? Number.POSITIVE_INFINITY) };
  } catch (err) {
    console.warn(`[hint] ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof GeminiCallError) return { ok: false, message: reasonToMessage(err.reason) };
    return { ok: false, message: 'Gemini is busy right now — try again in a minute.' };
  }
}
