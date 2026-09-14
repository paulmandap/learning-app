import { supabase } from './supabase';
import { GeminiBrowserProvider } from '../ai/gemini';
import { LABEL_MODEL } from '../ai/models';
import { isMissingColumn } from '../core/db-errors';
import { isStoredLabels, type LabelBox, type StoredLabels } from '../core/label-cover';
import { CallQueue } from '../core/queue';

/**
 * Where the labels are on each picture in a set (migration 0019, NOTES §44).
 *
 * Found once per picture and kept on its document, so a card can cover the
 * label its answer is (`placePicture`, src/core/label-cover.ts). Found right
 * after a set's cards are made, and — for sets made before this existed — the
 * first time one of a picture's cards comes up.
 *
 * Everything here is best effort and fails towards safety: positions that are
 * missing, unreadable, or placed by any model but `LABEL_MODEL` count as none,
 * and a picture with none shows with the answer.
 */

let warnedNoColumn = false;
function noColumn(): void {
  if (warnedNoColumn) return;
  warnedNoColumn = true;
  console.warn(
    '[labels] no "labels" column — pictures show with the answer. ' +
      'Apply supabase/migrations/0019_picture_labels.sql to cover answers on them instead.',
  );
}

const trusted = (labels: unknown): labels is StoredLabels => isStoredLabels(labels) && labels.model === LABEL_MODEL;

/** Label positions for a set's pictures, by document — only those the measured model placed. */
export async function pictureLabels(setId: string): Promise<Map<string, LabelBox[]>> {
  const out = new Map<string, LabelBox[]>();
  const { data, error } = await supabase
    .from('documents')
    .select('id, labels')
    .eq('study_set_id', setId)
    .eq('kind', 'image');

  if (error) {
    if (isMissingColumn(error)) noColumn();
    else console.warn(`[labels] could not read label positions: ${error.message}`);
    return out;
  }
  for (const row of (data ?? []) as { id: string; labels: unknown }[]) {
    if (trusted(row.labels)) out.set(row.id, row.labels.labels);
  }
  return out;
}

/**
 * Find the labels on a set's pictures that have none yet — one, or all of them.
 *
 * One request per picture, to `LABEL_MODEL` only, through a queue so a busy
 * model is waited for rather than skipped. A picture that fails is logged and
 * left without positions, to be tried again next time.
 */
export async function locatePictureLabels(input: {
  setId: string;
  apiKey: string;
  documentId?: string;
}): Promise<{ located: number; failed: number }> {
  let query = supabase
    .from('documents')
    .select('id, storage_path, labels')
    .eq('study_set_id', input.setId)
    .eq('kind', 'image');
  if (input.documentId) query = query.eq('id', input.documentId);
  const { data, error } = await query;

  if (error) {
    if (isMissingColumn(error)) noColumn();
    else console.warn(`[labels] could not list pictures: ${error.message}`);
    return { located: 0, failed: 0 };
  }

  const todo = ((data ?? []) as { id: string; storage_path: string | null; labels: unknown }[]).filter(
    (d) => d.storage_path !== null && !trusted(d.labels),
  );
  if (todo.length === 0 || !input.apiKey) return { located: 0, failed: 0 };

  const provider = new GeminiBrowserProvider(input.apiKey);
  const queue = new CallQueue();
  let located = 0;
  let failed = 0;

  for (const doc of todo) {
    try {
      const file = await supabase.storage.from('documents').download(doc.storage_path!);
      if (file.error || !file.data) throw new Error(file.error?.message ?? 'the picture did not download');
      const picture = file.data;
      const labels = await queue.run(() => provider.locateLabels({ file: picture, mime: picture.type || 'image/jpeg' }));
      if (labels === null) throw new Error('the reply held no positions that can be trusted');

      const stored: StoredLabels = { model: LABEL_MODEL, labels };
      const saved = await supabase.from('documents').update({ labels: stored }).eq('id', doc.id);
      if (saved.error) {
        if (isMissingColumn(saved.error)) {
          noColumn();
          return { located, failed };
        }
        throw new Error(saved.error.message);
      }
      located++;
    } catch (err) {
      failed++;
      console.warn(`[labels] could not find the labels on a picture: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { located, failed };
}
