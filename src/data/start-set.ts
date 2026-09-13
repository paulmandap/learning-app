import {
  addDocumentToSet,
  extendPlanForDocument,
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
  source: PasteSource | FileSource;
  count: number;
  apiKey: string;
  /** "Reading your notes…", "Planning your cards…", for a screen that shows it. */
  onStatus?: (status: string) => void;
}): Promise<{ setId: string }> {
  const setId = input.setId ?? (await createSet(input.title)).id;

  input.onStatus?.('Reading your notes…');
  const { documentId } = await addDocumentToSet({
    setId,
    apiKey: input.apiKey,
    title: input.title,
    source: input.source,
  });

  input.onStatus?.('Planning your cards…');
  if (input.setId) {
    await extendPlanForDocument({ setId, documentId, requestedCount: input.count });
  } else {
    await planSet(setId, input.count);
  }
  return { setId };
}
