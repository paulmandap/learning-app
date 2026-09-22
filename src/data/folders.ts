import { supabase, type Db } from './supabase';
import { isMissingColumn, isMissingTable } from '../core/db-errors';
import { checkFolderName, type Folder } from '../core/folders';

/**
 * Folders (NOTES §47). RLS scopes every query to the signed-in user, so nothing
 * here filters by user_id — the database decides.
 *
 * A folder is a LABEL, not a container. `study_sets.folder_id` is
 * `on delete set null` (0024), so deleting a folder puts its sets back on the
 * top level and never deletes them — somebody tidying up their groupings must
 * not lose a set, with all its cards, answers and review dates, and find out
 * afterwards.
 */

/** Thrown when the database has not got 0024 yet. */
export class FoldersUnavailableError extends Error {
  constructor() {
    super('Folders are not switched on yet.');
    this.name = 'FoldersUnavailableError';
  }
}

async function currentUserId(db: Db = supabase): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

/**
 * Every folder on this account.
 *
 * Returns nothing before 0024 rather than throwing, so Home still renders while
 * the migration is outstanding — every set simply shows ungrouped, which is
 * what the account actually looks like.
 */
export async function listFolders(db: Db = supabase): Promise<Folder[]> {
  // `parent_id` arrives with 0025. Asked for separately so a build deployed
  // before the migration still lists folders instead of failing the whole
  // screen — the same rule as `listSets` and NOTES §19.4.
  let { data, error } = await db.from('folders').select('id, name, created_at, parent_id');
  if (isMissingColumn(error)) {
    console.warn('[folders] no parent_id yet (apply migration 0025); no subfolders.');
    ({ data, error } = await db.from('folders').select('id, name, created_at'));
  }

  if (isMissingTable(error)) return [];
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as Folder[];
}

/**
 * Make a folder, optionally inside another (0025).
 *
 * Two levels only, and a folder that already holds subfolders cannot go inside
 * one. Both are enforced by `folders_shape_guard`, which raises 23514 — turned
 * into the sentence it means here, because a database error is not something a
 * person can act on.
 */
export async function createFolder(
  name: string,
  parentId: string | null = null,
  db: Db = supabase,
): Promise<Folder> {
  // Checked here so a blank or over-long name costs no round trip and the
  // person is told in words. The database still checks; this only saves the trip.
  const checked = checkFolderName(name);
  if (!checked.ok) throw new Error(checked.reason);

  const user_id = await currentUserId(db);
  const make = (withParent: boolean) =>
    db
      .from('folders')
      .insert({ user_id, name: checked.name, ...(withParent && parentId ? { parent_id: parentId } : {}) })
      .select(withParent ? 'id, name, created_at, parent_id' : 'id, name, created_at')
      .single();

  let { data, error } = await make(true);

  // Before 0025 there is no parent_id at all. A top-level folder can still be
  // made — ask again without the column. A SUBfolder cannot, and says so rather
  // than quietly making a top-level one somebody did not ask for.
  if (isMissingColumn(error)) {
    if (parentId) throw new FoldersUnavailableError();
    ({ data, error } = await make(false));
  }

  // 23514 is `folders_shape_guard`: two levels, no loops, and a folder that
  // already holds folders cannot go inside one.
  if (error?.code === '23514') throw new Error(error.message.replace(/^.*?:\s*/, '') || 'Folders only go two deep.');
  if (isMissingTable(error)) throw new FoldersUnavailableError();
  // 23505: the unique on (user_id, lower(name)). Two tabs can still race past
  // the check above, and "already exists" is the honest answer either way.
  if (error?.code === '23505') throw new Error(`You already have a folder called "${checked.name}".`);
  if (error) throw new Error(error.message);
  return data as unknown as Folder;
}

export async function renameFolder(id: string, name: string, db: Db = supabase): Promise<void> {
  const checked = checkFolderName(name);
  if (!checked.ok) throw new Error(checked.reason);

  const { error } = await db.from('folders').update({ name: checked.name }).eq('id', id);
  if (isMissingTable(error)) throw new FoldersUnavailableError();
  if (error?.code === '23505') throw new Error(`You already have a folder called "${checked.name}".`);
  if (error) throw new Error(error.message);
}

/**
 * Delete a folder. Its sets are NOT deleted — they go back to the top level.
 *
 * That is the database's doing (`on delete set null`), not this function's, so
 * it holds however the row is removed. Said here as well because it is the one
 * thing somebody needs to believe before tapping it.
 */
export async function deleteFolder(id: string, db: Db = supabase): Promise<void> {
  const { error } = await db.from('folders').delete().eq('id', id);
  if (isMissingTable(error)) throw new FoldersUnavailableError();
  if (error) throw new Error(error.message);
}

/**
 * Which folder a set is in, or null.
 *
 * Its own read rather than something the set screen carries, because
 * `readableSet` shapes a shared set as a StudySet too and a shared set has no
 * folder of yours — reading it from there would mean the screen believing a
 * stranger's set was in one of your folders.
 */
export async function folderOfSet(setId: string, db: Db = supabase): Promise<string | null> {
  const { data, error } = await db
    .from('study_sets')
    .select('folder_id')
    .eq('id', setId)
    .maybeSingle();

  if (isMissingColumn(error)) return null;
  if (error) throw new Error(error.message);
  return (data as { folder_id?: string | null } | null)?.folder_id ?? null;
}

/** Put a set in a folder, or take it out of one with `null`. */
export async function moveSetToFolder(
  setId: string,
  folderId: string | null,
  db: Db = supabase,
): Promise<void> {
  const { error } = await db.from('study_sets').update({ folder_id: folderId }).eq('id', setId);
  if (isMissingColumn(error)) throw new FoldersUnavailableError();
  if (error) throw new Error(error.message);
}
