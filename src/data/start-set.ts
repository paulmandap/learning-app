import {
  addDocumentToSet,
  extendPlanForDocuments,
  planSet,
  type FileSource,
  type PasteSource,
} from './pipeline';
import { createSet } from './sets';

/**
 * Start making cards from some notes: a new set, or more cards in one that exists.
 *
 * One way to do it, shared by Add notes and by Nomi (NOTES §37). Add notes'
 * own comment names what a second copy costs: *"A second copy would drift from
 * this one the first time either changed."*
 *
 * This reads the notes and plans the cards. The cards themselves are made by
 * the set screen, which resumes any set still being made — so whoever calls
 * this sends the student there next.
 */
export async function startSet(input: {
  /** Add to this set; start a new one when absent. */
  setId?: string;
  title: string;
  /**
   * What to read, in order. Usually one thing: pasted text or a file. A note
   * with pictures is its text and then each picture (NOTES §43) — every one its
   * own document in the set, so a card made from a picture shows that picture.
   * Empty text is skipped.
   */
  sources: (PasteSource | FileSource)[];
  count: number;
  apiKey: string;
  /**
   * Make the student's own questions and answers into cards exactly as written
   * (NOTES §49). Off unless asked for: a reviewer Nomi wrote is Gemini's
   * words, not the student's, and is made into cards the ordinary way.
   */
  keepWording?: boolean;
  /** "Reading your notes…", "Planning your cards…", for a screen that shows it. */
  onStatus?: (status: string) => void;
}): Promise<{ setId: string }> {
  const sources = input.sources.filter((s) => !('text' in s) || s.text.trim().length > 0);
  if (sources.length === 0) throw new Error('There is nothing here to make cards from yet.');

  const setId = input.setId ?? (await createSet(input.title)).id;

  const documentIds: string[] = [];
  let firstFailure: unknown = null;
  let picture = 0;
  for (const [i, source] of sources.entries()) {
    input.onStatus?.(sources.length > 1 ? `Reading your notes… (${i + 1} of ${sources.length})` : 'Reading your notes…');
    const isPicture = sources.length > 1 && !('text' in source);
    if (isPicture) picture++;
    try {
      const { documentId } = await addDocumentToSet({
        setId,
        apiKey: input.apiKey,
        title: isPicture ? `${input.title} — picture ${picture}` : input.title,
        source,
      });
      documentIds.push(documentId);
    } catch (err) {
      // With several things to read, one that fails costs its own cards and no
      // more: the rest are still read, and it is logged. With nothing read at
      // all, the first failure is the one to show.
      console.warn(`[start-set] could not read part ${i + 1} of ${sources.length}: ${err instanceof Error ? err.message : String(err)}`);
      firstFailure ??= err;
    }
  }
  if (documentIds.length === 0) throw firstFailure;

  input.onStatus?.('Planning your cards…');
  const keep = { keepWording: input.keepWording === true, apiKey: input.apiKey };
  if (input.setId) {
    await extendPlanForDocuments({ setId, documentIds, requestedCount: input.count, ...keep });
  } else {
    await planSet(setId, input.count, keep);
  }
  return { setId };
}
