import { supabase } from './supabase';

/**
 * The notebook (migration 0012).
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
 *  - **It has to work with one hand on a phone.** No folders, no tags, no
 *    formatting. A list, a title, a body, and a button that turns it into cards.
 *
 * RLS restricts every call here to the signed-in user, so no query filters by
 * id in client code — the database does it. Client-side filtering is not
 * authorisation.
 */

export interface Note {
  id: string;
  title: string;
  body: string;
  /** The set this note's cards went into, if any. */
  study_set_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A note in the list: everything but the body, which can be long. */
export type NoteSummary = Omit<Note, 'body'> & { body: string };

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

function rethrow(error: { code?: string; message: string }): never {
  if (error.code !== undefined && TABLE_MISSING_CODES.includes(error.code)) {
    console.warn(
      '[notes] no "notes" table — apply supabase/migrations/0012_notes.sql to turn the notebook on.',
    );
    throw new NotesUnavailableError();
  }
  throw new Error(error.message);
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
  const { data, error } = await supabase
    .from('notes')
    .select('id, title, body, study_set_id, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (error) rethrow(error);
  return (data ?? null) as Note | null;
}

/**
 * Start a note.
 *
 * Created empty and immediately, before a word is typed, so that every
 * keystroke afterwards has somewhere to go. Creating it lazily on first save
 * would mean the first save is also the riskiest one.
 */
export async function createNote(): Promise<Note> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw new Error(userError.message);
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in.');

  const { data, error } = await supabase
    .from('notes')
    .insert({ user_id: userId, title: '', body: '' })
    .select('id, title, body, study_set_id, created_at, updated_at')
    .single();

  if (error) rethrow(error);
  return data as Note;
}

/** Save what has been typed. `updated_at` is set by the trigger, not here. */
export async function saveNote(input: {
  id: string;
  title: string;
  body: string;
}): Promise<void> {
  const { error } = await supabase
    .from('notes')
    .update({ title: input.title, body: input.body })
    .eq('id', input.id);

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
  const { error } = await supabase.from('notes').delete().eq('id', id);
  if (error) rethrow(error);
}
