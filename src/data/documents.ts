import { supabase } from './supabase';
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
    .select('id, study_set_id, kind, title, storage_path, page_count, status, unreadable_pages, created_at')
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
    .select('id, study_set_id, kind, title, storage_path, page_count, status, unreadable_pages, created_at')
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
    .update({ storage_path: path })
    .eq('id', documentId);

  if (updateError) throw new Error(updateError.message);
  return path;
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

  const { data, error } = await supabase
    .from('document_pages')
    .select('id, document_id, page_index, text, readability, headings')
    .in('document_id', ids)
    .order('page_index', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as StoredPage[];
}
