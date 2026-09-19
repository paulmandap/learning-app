/**
 * Folders, for grouping sets (NOTES §47).
 *
 * The owner: *"under 'your sets' it would be cool if the users can add folders
 * and put the flashcards inside the folder for easier groupings and cleaner
 * look. it can be either by tapping buttons or drag and drop."*
 *
 * ## Tapping, not dragging
 *
 * Both were offered and tapping is what this builds. Drag and drop across a
 * scrolling list needs a gesture library — this app has none and does not add
 * one without a measured reason — and it needs a second way in anyway, because
 * dragging is the one gesture that does not survive a screen reader, a
 * keyboard, or a phone held one-handed on a bus. A "Move to folder" choice does
 * the same job, works everywhere, and can be undone by choosing again.
 *
 * ## One level, and one folder per set
 *
 * A set in two folders is a set you have to look for twice. Nesting needs a
 * navigator, a breadcrumb and a move-to-parent gesture before it is usable,
 * which is a file manager rather than a study app. The database enforces both
 * (migration 0024: `study_sets.folder_id` is a single nullable column).
 *
 * Pure. No react-native, no supabase.
 */

export interface Folder {
  id: string;
  name: string;
  created_at: string;
}

/** The longest a folder name may be. Mirrors the check in migration 0024. */
export const MAX_FOLDER_NAME = 60;

export type FolderNameCheck = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Is this a name the database will take, and does it already exist?
 *
 * `existing` makes the duplicate a sentence rather than a constraint violation.
 * The database has the last word — two tabs can still race — but a name someone
 * can see is already there should be refused before a round trip.
 *
 * Case-insensitive, matching `unique (user_id, lower(name))`: "anatomy" and
 * "Anatomy" as two folders is a mistake every time.
 */
export function checkFolderName(raw: string, existing: readonly Folder[] = []): FolderNameCheck {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, reason: 'Give the folder a name.' };
  if (name.length > MAX_FOLDER_NAME) {
    return { ok: false, reason: `That name is too long — keep it under ${MAX_FOLDER_NAME} characters.` };
  }
  if (existing.some((f) => f.name.trim().toLowerCase() === name.toLowerCase())) {
    return { ok: false, reason: `You already have a folder called "${name}".` };
  }
  return { ok: true, name };
}

export interface FolderedSets<T> {
  folder: Folder;
  sets: T[];
}

export interface Grouping<T> {
  /** Folders, each with the sets inside it. Empty folders are kept — see below. */
  folders: FolderedSets<T>[];
  /** Sets in no folder, shown under the folders. */
  loose: T[];
}

/**
 * Sets arranged into their folders.
 *
 * ## Empty folders stay
 *
 * A folder you have just made is empty, and a folder that hides itself the
 * moment its last set moves out is a folder you cannot put anything back into.
 * The screen shows "No sets in here yet" rather than nothing.
 *
 * ## The order within a folder is the caller's
 *
 * `sets` arrive already ordered — due first, on Home — and this only
 * distributes them. Sorting here would quietly override a decision made
 * somewhere that knows more (`dueFirst` in src/core/set-order.ts).
 *
 * A set pointing at a folder that is not in `folders` falls back to loose
 * rather than disappearing. That is a real state for a moment: deleting a
 * folder sets its sets' `folder_id` to null, and the two queries can land
 * either way round.
 */
export function groupSets<T extends { id: string; folder_id?: string | null }>(
  sets: readonly T[],
  folders: readonly Folder[],
): Grouping<T> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const buckets = new Map<string, T[]>(folders.map((f) => [f.id, []]));
  const loose: T[] = [];

  for (const set of sets) {
    const id = set.folder_id ?? null;
    if (id !== null && byId.has(id)) buckets.get(id)!.push(set);
    else loose.push(set);
  }

  return {
    folders: folders.map((folder) => ({ folder, sets: buckets.get(folder.id) ?? [] })),
    loose,
  };
}

/**
 * Folders in the order they are shown: by name, so the list does not move
 * around as sets go in and out of them.
 *
 * Plain comparison rather than localeCompare, which sorts differently depending
 * on where it runs and would make this untestable — the same reason
 * `src/core/community.ts` gives for the ranking's tie-break. Case-insensitive,
 * so "anatomy" does not sort below "Zoology".
 */
export function folderOrder(folders: readonly Folder[]): Folder[] {
  return folders.slice().sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** "3 sets" / "1 set" / "No sets in here yet". */
export function folderMeta(count: number, due: number): string {
  if (count === 0) return 'No sets in here yet';
  const sets = `${count} set${count === 1 ? '' : 's'}`;
  return due > 0 ? `${sets} · ${due} due` : sets;
}
