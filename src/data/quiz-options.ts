import { GeminiBrowserProvider } from '../ai/gemini';
import { trimNotes } from '../core/chat';
import { CallQueue } from '../core/queue';
import { choicesFrom, needsChoices } from '../core/quiz';
import { pagesForSet } from './documents';
import { listItems } from './items';
import { supabase } from './supabase';

/**
 * Answer choices for every card in a set that has none, so the whole set can be
 * asked in the quiz (NOTES §38).
 *
 * Gemini writes three wrong answers per card from the set's notes;
 * `choicesFrom` checks them; the checked list is saved on the card as its
 * `options`. The card keeps its kind — a flashcard is still a flashcard, still
 * a fill-in-the-blank — it simply also has choices now.
 *
 * Called after a set finishes, and by the quiz when it opens on cards that
 * still have none. Best effort both times: a card whose choices were not
 * written is asked with choices taken from the other cards (`choicesFromSet`).
 */

/** Cards in one request. */
export const CHOICES_PER_CALL = 15;

/** How much of the notes go with a request — enough to find wrong answers in. */
const NOTES_FOR_CHOICES = 12_000;

export async function addQuizChoices(input: {
  setId: string;
  apiKey: string;
}): Promise<{ written: number; notWritten: number }> {
  const items = await listItems(input.setId);
  const need = items.filter(needsChoices);
  if (need.length === 0) return { written: 0, notWritten: 0 };
  if (!input.apiKey) return { written: 0, notWritten: need.length };

  const pages = await pagesForSet(input.setId);
  const notes = trimNotes(pages.map((p) => p.text).join('\n\n'), NOTES_FOR_CHOICES);
  const provider = new GeminiBrowserProvider(input.apiKey);
  const queue = new CallQueue();

  const batches: (typeof need)[] = [];
  for (let i = 0; i < need.length; i += CHOICES_PER_CALL) batches.push(need.slice(i, i + CHOICES_PER_CALL));

  let written = 0;
  const results = await Promise.allSettled(
    batches.map((batch) =>
      queue.run(async () => {
        // Numbered 1..n rather than by id: a model asked to repeat a UUID back
        // is a model asked to get 36 characters exactly right.
        const replies = await provider.writeWrongOptions({
          notes,
          cards: batch.map((c, i) => ({ n: i + 1, prompt: c.prompt, answer: c.answer })),
        });
        const wrongByN = new Map(replies.map((r) => [r.n, r.wrong]));
        for (const [i, card] of batch.entries()) {
          const options = choicesFrom(card, wrongByN.get(i + 1) ?? []);
          if (!options) continue;
          const { error } = await supabase.from('study_items').update({ options }).eq('id', card.id);
          if (error) console.warn(`[quiz] could not save choices for a card: ${error.message}`);
          else written++;
        }
      }),
    ),
  );

  for (const r of results) {
    if (r.status === 'rejected') {
      console.warn(`[quiz] could not write answer choices: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  }
  return { written, notWritten: need.length - written };
}
