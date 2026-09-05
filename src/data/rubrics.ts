import { GeminiBrowserProvider } from '../ai/gemini';
import { CallQueue } from '../core/queue';
import { rubricVerdict, shouldVerifyRubric } from '../core/rubric';
import { itemsNeedingRubricCheck, promptFor, saveRubricVerdict } from './items';
import { pagesForSet } from './documents';

export interface RubricPassResult {
  checked: number;
  flagged: number;
  failed: number;
}

/**
 * D7's postponed second pass, over Apply-tier rubrics only.
 *
 * ## Why this runs AFTER generation rather than inside it
 *
 * Spec §6 makes the two-minute figure for Phase 2 a measured target that must
 * not be bought by weakening the architecture — and one extra model call per
 * Apply item would land squarely on that path. Apply is 20% of a set, so a
 * 20-card set is four more calls, which at the enforced 7s gap is ~28s added to
 * a budget that already has thin headroom (NOTES §5.3.2).
 *
 * So the set is marked ready first and the cards are usable immediately; this
 * catches up behind it. A student who starts studying before it finishes sees
 * cards without a verdict, which is exactly what `rubric_verified = null` means.
 *
 * ## Why a failure here changes nothing about the card
 *
 * `rubric_verified = false` is a soft failure by design (§4): the card stays,
 * and the quiz shows a quiet caution. Dropping a question because a second model
 * disliked one point of its marking checklist would be a large action on a small
 * and fallible signal.
 */
export async function verifyRubrics(input: {
  setId: string;
  apiKey: string;
  /** Cap on model calls, so one enormous set cannot spend a day's quota. */
  limit?: number;
}): Promise<RubricPassResult> {
  const result: RubricPassResult = { checked: 0, flagged: 0, failed: 0 };
  if (!input.apiKey) return result;

  let candidates;
  try {
    candidates = await itemsNeedingRubricCheck(input.setId);
  } catch (err) {
    console.warn(
      `[rubric] could not list candidates: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  const todo = candidates
    .filter((item) =>
      shouldVerifyRubric({
        kind: item.kind,
        level: item.level,
        rubric: item.rubric,
        rubricVerified: item.rubric_verified,
      }),
    )
    .slice(0, input.limit ?? 12);

  if (todo.length === 0) return result;

  // The whole page, not just the cited sentence. Judging a checklist against one
  // resolved sentence flagged 4 of 4 real rubrics wrongly on the first live run
  // — the rubric was written from the section, so that is what it must be
  // checked against. See buildRubricCheckPrompt.
  let pageText = new Map<number, string>();
  try {
    const pages = await pagesForSet(input.setId);
    pageText = new Map(pages.map((p) => [p.page_index, p.text]));
  } catch (err) {
    console.warn(
      `[rubric] could not load page text: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  const provider = new GeminiBrowserProvider(input.apiKey);
  // One queue for the whole pass, so its concurrency of 2 and ~7s gap govern
  // the batch rather than each item pacing itself.
  const queue = new CallQueue();

  await Promise.allSettled(
    todo.map((item) =>
      queue.run(async () => {
        const rubric = item.rubric;
        if (!rubric) return;

        try {
          const reply = await provider.verifyRubric({
            prompt: promptFor(item),
            rubric,
            sourceExcerpt: item.source_excerpt,
            sourceText: pageText.get(item.page_index ?? 0) ?? item.source_excerpt,
          });

          // An unparseable second opinion is not evidence against the card.
          // Leaving rubric_verified null lets a later pass try again.
          if (!reply) {
            result.failed++;
            console.warn(`[rubric] ${item.id}: model returned nothing usable`);
            return;
          }

          const verdict = rubricVerdict(rubric.expected_concepts, reply);
          await saveRubricVerdict(item.id, verdict.verified);
          result.checked++;
          if (!verdict.verified) {
            result.flagged++;
            console.warn(
              `[rubric] ${item.id}: unsupported ${verdict.unsupported.join(', ')}` +
                `${verdict.note ? ` — ${verdict.note}` : ''}`,
            );
          }
        } catch (err) {
          result.failed++;
          console.warn(
            `[rubric] ${item.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    ),
  );

  return result;
}
