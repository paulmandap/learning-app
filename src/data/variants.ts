import { GeminiBrowserProvider } from '../ai/gemini';
import { CallQueue } from '../core/queue';
import { shouldRephrase, validateVariant } from '../core/variant';
import { getItem, promptFor, saveVariantPrompt } from './items';

/**
 * Variants of missed items (spec §3.3, "Later").
 *
 * A card failed three times gets its question rewritten once. Everything about
 * whether that is allowed, and whether the result is usable, lives in
 * `src/core/variant.ts`; this module is the plumbing around it.
 *
 * **Best effort, and loudly so.** A rephrase that fails must never cost the
 * student their answer — the attempt row and the schedule have already been
 * written by the time this runs. But it is logged rather than swallowed:
 * a silently failing pass is indistinguishable from one that never ran, and
 * that exact ambiguity has already produced one wrong conclusion in this
 * codebase (ARCHITECTURE_NOTES §5.3.2).
 */
export async function maybeRephrase(input: {
  studyItemId: string;
  lapses: number;
  apiKey: string;
}): Promise<'skipped' | 'written' | 'rejected' | 'failed'> {
  if (!input.apiKey) return 'skipped';

  try {
    const item = await getItem(input.studyItemId);
    if (!item) return 'skipped';

    if (!shouldRephrase({ lapses: input.lapses, alreadyRephrased: item.variant_prompt !== null })) {
      return 'skipped';
    }

    // Through the queue like every other model call: this fires from a study
    // screen at the moment the student answers, so it competes with nothing —
    // but the ~7s gap and the retry ladder (§3.2.6) still apply to it.
    const provider = new GeminiBrowserProvider(input.apiKey);
    const reply = await new CallQueue().run(() =>
      provider.rephrasePrompt({
        // Rephrase what the student is actually being shown. On a card that has
        // somehow been rephrased before, rewriting the original again would
        // produce a "variant" of something they have not seen.
        prompt: promptFor(item),
        answer: item.answer,
        sourceExcerpt: item.source_excerpt,
      }),
    );

    if (!reply) {
      console.warn(`[variant] ${input.studyItemId}: model returned nothing usable`);
      return 'failed';
    }

    const checked = validateVariant({
      original: item.prompt,
      rephrased: reply.prompt,
      answer: item.answer,
      sourceExcerpt: item.source_excerpt,
    });

    if (!checked.ok) {
      // Not an error — a rewrite that leaks the answer or barely differs is
      // exactly what these checks are for. The card keeps its original wording.
      console.warn(`[variant] ${input.studyItemId}: rejected (${checked.reason})`);
      return 'rejected';
    }

    await saveVariantPrompt(input.studyItemId, checked.prompt);
    return 'written';
  } catch (err) {
    console.warn(
      `[variant] ${input.studyItemId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'failed';
  }
}
