import { supabase } from './supabase';
import { isMissingColumn } from '../core/db-errors';
import { isRichDoc, noteImagePath, type RichDoc } from '../core/rich-note';

/**
 * The notebook (migration 0012), with formatting and pictures since 0018.
 *
 * The owner's brief: *"add a note tab. a good feature is that let's say i'm in
 * class writing notes using the learning app, it would be great if there's a
 * button to immediately transform the notes into flashcards."*
 *
 * Two things follow from "in class", and they shape everything here:
 *
 *  - **Losing a note is unacceptable.** Cards can be regenerated; an hour of
 *    someone's own writing cannot. So saves are frequent, failures are visible
 *    rather than swallowed, and nothing deletes a note as a side effect —
 *    `study_set_id` is `on delete set null` so binning the cards keeps the note.
 *  - **It has to work with one hand on a phone.** No folders, no tags. A list,
 *    a title, a body, and a button that turns it into cards.
 *
 * ## Formatting and pictures (NOTES §43)
 *
 * The note as the editor keeps it — headings, lists, pictures — is `content`.
 * `body` stays the note's plain text, written from `content` on every save, and
 * is still what cards, previews and word counts read. Pictures live in the
 * private `note-images` bucket under `<user>/<note>/`, and the note holds only
 * their paths. Until migration 0018 there is no `content` column and no bucket:
 * the note saves its text as before, and adding a picture says it is not
 * switched on yet.
 *
 * RLS restricts every call here to the signed-in user, so no query filters by
 * id in client code — the database does it. Client-side filtering is not
 * authorisation.
 */

export interface Note {
  id: string;
  title: string;
  body: string;
  /** The formatted note (0018). Null for a note never saved by the editor, or before the migration. */
  content: RichDoc | null;
  /** The set this note's cards went into, if any. */
  study_set_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A note in the list: everything but the formatted content, which can be large. */
export type NoteSummary = Omit<Note, 'content'>;

const IMAGES = 'note-images';

/**
 * "That table does not exist" — i.e. migration 0012 has not been applied.
 *
 * TWO codes, and the second one is the one that actually arrives. Postgres
 * raises `42P01` for an unknown relation, but a request through PostgREST
 * never reaches Postgres at all: it is rejected against the schema cache first
 * and comes back as `PGRST205`.
 *
 * Found by running it. With only `42P01` handled, the error fell through as a
 * generic failure, the list rendered with zero rows, and the tab showed a
 * convincing "Nothing written yet" — an empty notebook, not a missing one, with
 * a "New note" button that could only fail.
 */
const TABLE_MISSING_CODES = ['42P01', 'PGRST205'];

export class NotesUnavailableError extends Error {
  constructor() {
    super('The notebook is not set up yet.');
    this.name = 'NotesUnavailableError';
  }
}

/** A picture was added before migration 0018 made somewhere to keep it. */
export class NoteImagesUnavailableError extends Error {
  constructor() {
    super("Pictures in notes aren't switched on yet.");
    this.name = 'NoteImagesUnavailableError';
  }
}

function rethrow(error: { code?: string; message: string }): never {
  if (error.code !== undefined && TABLE_MISSING_CODES.includes(error.code)) {
    console.warn(
      '[notes] no "notes" table — apply supabase/migrations/0012_notes.sql to turn the notebook on.',
    );
    throw new NotesUnavailableError();
  }
  throw new Error(error.message);
}

let warnedNoContent = false;
function noteNoContent(): void {
  if (warnedNoContent) return;
  warnedNoContent = true;
  console.warn(
    '[notes] no "content" column — notes save as plain text. ' +
      'Apply supabase/migrations/0018_rich_notes_and_note_images.sql to keep their formatting and pictures.',
  );
}

async function currentUserId(): Promise<string> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw new Error(userError.message);
  const id = userData.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

/**
 * Every note, newest edit first.
 *
 * The body comes with it. A preview line needs the first sentence anyway, and
 * over a realistic notebook — a few dozen notes of a few thousand characters —
 * one query returning everything beats a list query plus a fetch per note the
 * moment anyone opens one.
 */
export async function listNotes(): Promise<NoteSummary[]> {
  const { data, error } = await supabase
    .from('notes')
    .select('id, title, body, study_set_id, created_at, updated_at')
    .order('updated_at', { ascending: false });

  if (error) rethrow(error);
  return (data ?? []) as NoteSummary[];
}

export async function fetchNote(id: string): Promise<Note | null> {
  const full = await supabase
    .from('notes')
    .select('id, title, body, content, study_set_id, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (!full.error) {
    const row = full.data as (Omit<Note, 'content'> & { content: unknown }) | null;
    return row ? { ...row, content: isRichDoc(row.content) ? row.content : null } : null;
  }
  if (!isMissingColumn(full.error)) rethrow(full.error);

  noteNoContent();
  const plain = await supabase
    .from('notes')
    .select('id, title, body, study_set_id, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();
  if (plain.error) rethrow(plain.error);
  return plain.data ? { ...(plain.data as NoteSummary), content: null } : null;
}

/**
 * Start a note.
 *
 * Created empty and immediately, before a word is typed, so that every
 * keystroke afterwards has somewhere to go. Creating it lazily on first save
 * would mean the first save is also the riskiest one.
 */
export async function createNote(): Promise<Note> {
  const userId = await currentUserId();

  const { data, error } = await supabase
    .from('notes')
    .insert({ user_id: userId, title: '', body: '' })
    .select('id, title, body, study_set_id, created_at, updated_at')
    .single();

  if (error) rethrow(error);
  return { ...(data as NoteSummary), content: null };
}

/**
 * Save what has been typed. `updated_at` is set by the trigger, not here.
 *
 * `content` is left out when there is none — a note opened and never edited in
 * the editor keeps whatever it had. Before migration 0018 a save with content
 * is refused as a missing column (PGRST204, not 42703 — NOTES §37), and is sent
 * again without it: the words are saved either way.
 */
export async function saveNote(input: {
  id: string;
  title: string;
  body: string;
  content?: RichDoc | null;
}): Promise<void> {
  const base = { title: input.title, body: input.body };
  if (input.content) {
    const { error } = await supabase.from('notes').update({ ...base, content: input.content }).eq('id', input.id);
    if (!error) return;
    if (!isMissingColumn(error)) rethrow(error);
    noteNoContent();
  }
  const { error } = await supabase.from('notes').update(base).eq('id', input.id);
  if (error) rethrow(error);
}

/** Remember which set this note's cards went into. Best effort. */
export async function linkNoteToSet(noteId: string, setId: string): Promise<void> {
  const { error } = await supabase
    .from('notes')
    .update({ study_set_id: setId })
    .eq('id', noteId);

  // Deliberately not thrown. The cards exist either way, and failing the whole
  // "make cards" flow because a cross-reference could not be written would
  // punish the student for a bookkeeping problem.
  if (error) console.warn(`[notes] could not link note to set: ${error.message}`);
}

export async function deleteNote(id: string): Promise<void> {
  // Its pictures first, best effort: a picture left behind costs a little
  // storage, while a note that would not delete because of one costs trust.
  await removeNoteImages(id);
  const { error } = await supabase.from('notes').delete().eq('id', id);
  if (error) rethrow(error);
}

// ---------------------------------------------------------------- pictures --

/** Keep a picture for a note, already shrunk by the caller. Returns where it is and a link to show it. */
export async function uploadNoteImage(noteId: string, image: Blob): Promise<{ path: string; url: string }> {
  const userId = await currentUserId();
  const path = noteImagePath(userId, noteId, Date.now());

  const { error } = await supabase.storage
    .from(IMAGES)
    .upload(path, image, { contentType: 'image/jpeg', upsert: false });
  if (error) {
    if (/bucket not found/i.test(error.message)) {
      console.warn(
        '[notes] no "note-images" bucket — apply supabase/migrations/0018_rich_notes_and_note_images.sql.',
      );
      throw new NoteImagesUnavailableError();
    }
    throw new Error(error.message);
  }

  const urls = await noteImageUrls([path]);
  return { path, url: urls[path] ?? '' };
}

/** Links to show a note's pictures, an hour long. A picture that cannot be linked is left out and logged. */
export async function noteImageUrls(paths: readonly string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await supabase.storage.from(IMAGES).createSignedUrls([...paths], 60 * 60);
  if (error || !data) {
    console.warn(`[notes] could not link a note's pictures: ${error?.message ?? 'no answer'}`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const entry of data) {
    if (entry.path && entry.signedUrl) out[entry.path] = entry.signedUrl;
    else if (entry.error) console.warn(`[notes] could not link ${entry.path ?? 'a picture'}: ${entry.error}`);
  }
  return out;
}

/**
 * A note's pictures as files, for making cards from them. One that will not
 * download is logged and left out, rather than costing the whole set.
 */
export async function downloadNoteImages(paths: readonly string[]): Promise<{ path: string; blob: Blob }[]> {
  const out: { path: string; blob: Blob }[] = [];
  for (const path of paths) {
    const { data, error } = await supabase.storage.from(IMAGES).download(path);
    if (error || !data) {
      console.warn(`[notes] could not download ${path}: ${error?.message ?? 'no data'}`);
      continue;
    }
    out.push({ path, blob: data });
  }
  return out;
}

async function removeFolder(prefix: string): Promise<number> {
  const { data, error } = await supabase.storage.from(IMAGES).list(prefix, { limit: 1000 });
  if (error || !data || data.length === 0) return 0;
  const files = data.filter((entry) => entry.id !== null).map((entry) => `${prefix}/${entry.name}`);
  if (files.length > 0) {
    const removed = await supabase.storage.from(IMAGES).remove(files);
    if (removed.error) console.warn(`[notes] could not remove pictures in ${prefix}: ${removed.error.message}`);
  }
  return files.length;
}

/** One note's pictures. Best effort, and quiet before migration 0018. */
export async function removeNoteImages(noteId: string): Promise<void> {
  try {
    const userId = await currentUserId();
    await removeFolder(`${userId}/${noteId}`);
  } catch (err) {
    console.warn(`[notes] could not remove a note's pictures: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Every picture in every note — for Delete my data. Best effort. */
export async function removeAllNoteImages(): Promise<void> {
  try {
    const userId = await currentUserId();
    const { data, error } = await supabase.storage.from(IMAGES).list(userId, { limit: 1000 });
    if (error || !data) return;
    // Folders come back with no id: one per note.
    for (const folder of data.filter((entry) => entry.id === null)) {
      await removeFolder(`${userId}/${folder.name}`);
    }
  } catch (err) {
    console.warn(`[notes] could not remove note pictures: ${err instanceof Error ? err.message : String(err)}`);
  }
}
