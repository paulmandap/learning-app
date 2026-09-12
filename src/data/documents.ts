import { completeRows, supabase, type Db } from './supabase';
import type { ReadResult } from '../ai/provider';

/**
 * Documents and their pages.
 *
 * A document belongs to a set (D9: a set is a subject, documents are added to
 * it). Originals live in the private `documents` bucket under
 * {user_id}/{document_id}/{filename} so the storage policy can key on the
 * first path segment.
 */

export type DocumentKind = 'text' | 'pdf' | 'image';
export type DocumentStatus = 'uploaded' | 'read' | 'failed';

export interface StoredDocument {
  id: string;
  study_set_id: string;
  kind: DocumentKind;
  title: string;
  storage_path: string | null;
  /** Size of the stored original. Null once freed, or if uploaded before 0009. */
  byte_size: number | null;
  page_count: number;
  status: DocumentStatus;
  unreadable_pages: number[];
  created_at: string;
}

export interface StoredPage {
  id: string;
  document_id: string;
  page_index: number;
  text: string;
  readability: number;
  headings: string[];
}

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

export async function listDocuments(studySetId: string): Promise<StoredDocument[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('id, study_set_id, kind, title, storage_path, byte_size, page_count, status, unreadable_pages, created_at')
    .eq('study_set_id', studySetId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as StoredDocument[];
}

/** Create the row first: its id is needed to build the storage path. */
export async function createDocument(input: {
  studySetId: string;
  kind: DocumentKind;
  title: string;
}): Promise<StoredDocument> {
  const user_id = await currentUserId();
  const { data, error } = await supabase
    .from('documents')
    .insert({
      user_id,
      study_set_id: input.studySetId,
      kind: input.kind,
      title: input.title.slice(0, 200),
      status: 'uploaded',
      page_count: 0,
    })
    .select('id, study_set_id, kind, title, storage_path, byte_size, page_count, status, unreadable_pages, created_at')
    .single();

  if (error) throw new Error(error.message);
  return data as StoredDocument;
}

/**
 * Upload the original so "Open page" has something to open.
 *
 * Uploaded to Supabase Storage, never left on Gemini's Files API — files there
 * are deleted after 48 hours, so it is transport, not storage.
 */
export async function uploadOriginal(
  documentId: string,
  file: Blob,
  filename: string,
): Promise<string> {
  const user_id = await currentUserId();
  const safeName = filename.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
  const path = `${user_id}/${documentId}/${safeName}`;

  const { error } = await supabase.storage
    .from('documents')
    .upload(path, file, { upsert: true, contentType: file.type || undefined });

  if (error) throw new Error(error.message);

  const { error: updateError } = await supabase
    .from('documents')
    // byte_size is recorded here and nowhere else, so the per-user total is one
    // `sum` rather than a walk over every prefix in the bucket.
    .update({ storage_path: path, byte_size: file.size })
    .eq('id', documentId);

  if (updateError) throw new Error(updateError.message);
  return path;
}

/**
 * How many bytes of originals this user is keeping.
 *
 * Rows with a null `byte_size` count as 0. Since `0013_backfill_byte_size.sql`
 * the only rows left like that are documents whose file has genuinely gone —
 * "Free up space" nulls the path and the size together — so zero is the right
 * answer for them.
 *
 * Before that migration it was NOT: every file uploaded before 0009 added the
 * column had a null size, so the dashboard could report "Nothing stored yet"
 * over a bucket full of PDFs. The note that used to sit here said the sizes
 * were "not recoverable", which was true from the browser and false from SQL —
 * Supabase records the real byte count on every object it stores. Worth
 * remembering the next time a column is added to a table that already has rows:
 * adding it is half the migration.
 *
 * Degrades to 0 rather than throwing — a usage figure is not worth blocking an
 * upload over, and the per-file limit still applies.
 */
export async function storageUsedBytes(db: Db = supabase): Promise<number> {
  const { data, error } = await db.from('documents').select('byte_size');
  if (error) {
    console.warn(`[storage] could not read usage: ${error.message}`);
    return 0;
  }
  return ((data ?? []) as { byte_size: number | null }[]).reduce(
    (total, row) => total + (row.byte_size ?? 0),
    0,
  );
}

/**
 * Free the space a set's originals take, and keep everything else.
 *
 * The insight this is built on: what fills a 1 GB bucket is the PDF, and a PDF
 * is 20-50 MB while the cards, answers and schedules made from it are kilobytes
 * in a different quota entirely. So there is no reason for "I need space" to
 * mean "delete my study set" — the two are not the same resource.
 *
 * What is lost is exactly one thing: "Open page" can no longer show the
 * original, and a card made from an image no longer shows its picture. Both
 * already check `storage_path` before offering anything, so nulling it degrades
 * them rather than breaking them — see openPage in the study screens.
 *
 * What is kept: every card, every answer, every review schedule, and the page
 * text the cards were grounded in. The source excerpt on each card still comes
 * from the user's own notes, because `document_pages` is untouched.
 *
 * Returns the number of bytes released.
 */
export async function freeUpSpace(studySetId: string): Promise<number> {
  const docs = await listDocuments(studySetId);
  const withFiles = docs.filter((d) => d.storage_path);
  if (withFiles.length === 0) return 0;

  const paths = withFiles.map((d) => d.storage_path!);
  const { error } = await supabase.storage.from('documents').remove(paths);
  // A file already gone is not a failure — the point is that it is not there
  // any more. But a real failure must not leave storage_path pointing at
  // nothing, so the row update is skipped and the caller sees zero freed.
  if (error) throw new Error(error.message);

  const { error: updateError } = await supabase
    .from('documents')
    .update({ storage_path: null, byte_size: null })
    .in('id', withFiles.map((d) => d.id));

  if (updateError) throw new Error(updateError.message);

  // Summed from what was read before the update, since the rows now say null.
  return withFiles.reduce((total, d) => total + (d.byte_size ?? 0), 0);
}

/** A short-lived signed URL. The bucket is private; there are no public links. */
export async function signedUrlFor(storagePath: string, page?: number): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(storagePath, 60 * 10);

  if (error || !data) return null;
  // Desktop browsers honour #page=N. iOS Safari ignores it and opens at page 1,
  // which is why the page number is also shown as text next to the link.
  return page !== undefined ? `${data.signedUrl}#page=${page + 1}` : data.signedUrl;
}

/**
 * Persist what the model read, and record which pages were unreadable.
 *
 * Unreadable pages are reported to the user, never silently dropped: a blurry
 * photo must be reported as unreadable, not turned into invented cards.
 */
export async function storeReadResult(
  documentId: string,
  result: ReadResult,
  minReadability: number,
): Promise<{ pageCount: number; unreadablePages: number[] }> {
  const user_id = await currentUserId();

  const rows = result.pages.map((page) => ({
    user_id,
    document_id: documentId,
    page_index: page.page_index,
    text: page.blocks.map((b) => b.text).join('\n\n').trim(),
    readability: page.readability,
    headings: page.headings,
  }));

  if (rows.length > 0) {
    const { error } = await supabase
      .from('document_pages')
      .upsert(rows, { onConflict: 'document_id,page_index' });
    if (error) throw new Error(error.message);
  }

  const unreadablePages = result.pages
    .filter((p) => p.readability < minReadability)
    .map((p) => p.page_index)
    .sort((a, b) => a - b);

  const { error: updateError } = await supabase
    .from('documents')
    .update({
      page_count: result.pages.length,
      unreadable_pages: unreadablePages,
      status: 'read',
    })
    .eq('id', documentId);

  if (updateError) throw new Error(updateError.message);
  return { pageCount: result.pages.length, unreadablePages };
}

export async function markDocumentFailed(documentId: string): Promise<void> {
  await supabase.from('documents').update({ status: 'failed' }).eq('id', documentId);
}

/** Every stored page for a set, used by the planner and by excerpt checking. */
export async function pagesForSet(studySetId: string): Promise<StoredPage[]> {
  const docs = await listDocuments(studySetId);
  const ids = docs.map((d) => d.id);
  if (ids.length === 0) return [];

  const result = await supabase
    .from('document_pages')
    // count: these pages ARE the source text generation reads. A short read
    // means whole pages are never turned into cards, and the set simply looks
    // thinner than the notes deserved.
    .select('id, document_id, page_index, text, readability, headings', { count: 'exact' })
    .in('document_id', ids)
    .order('page_index', { ascending: true });

  if (result.error) throw new Error(result.error.message);
  return completeRows('pagesForSet', result) as StoredPage[];
}
