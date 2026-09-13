import { GeminiBrowserProvider } from '../ai/gemini';
import type { AIProvider } from '../ai/provider';
import { CallQueue } from '../core/queue';
import { checkReviewer, reviewerFacts } from '../core/reviewer';

/**
 * Nomi writing a reviewer on a topic the student named (NOTES §39).
 *
 * Called only from `carryOut`, after the tap — asking for a reviewer costs
 * nothing until the student says yes. What comes back is checked by
 * `checkReviewer` before anything is saved, so a refusal or a few lines never
 * becomes a note or a set.
 */

/** Its own queue, for the reason nomi-chat.ts gives: it must not wait behind a set being made. */
const queue = new CallQueue();

/** Gemini answered, but not with something cards can be made from. */
export class ReviewerUnusableError extends Error {
  constructor() {
    super("Couldn't write a reviewer on that topic.");
    this.name = 'ReviewerUnusableError';
  }
}

export async function writeReviewer(
  input: { topic: string; count: number; apiKey: string },
  deps: {
    provider?: Pick<AIProvider, 'writeReviewer'>;
    /** How the call is scheduled: the queue in production, straight through in a test. */
    run?: <T>(task: () => Promise<T>) => Promise<T>;
  } = {},
): Promise<string> {
  const provider = deps.provider ?? new GeminiBrowserProvider(input.apiKey);
  const run = deps.run ?? (<T>(task: () => Promise<T>) => queue.run(task));

  const written = await run(() => provider.writeReviewer({ topic: input.topic, facts: reviewerFacts(input.count) }));
  const checked = checkReviewer(written ?? '');
  if (!checked.ok) {
    console.warn(`[reviewer] "${input.topic}": nothing usable came back (${checked.reason}).`);
    throw new ReviewerUnusableError();
  }
  // Not a failure — the set fills what the notes hold — but a count that stops
  // short with no trace of why is how a wrong conclusion starts.
  if (checked.supports < input.count) {
    console.warn(
      `[reviewer] "${input.topic}": ${checked.facts} facts hold about ${checked.supports} cards; ${input.count} were asked for.`,
    );
  }
  return checked.notes;
}
