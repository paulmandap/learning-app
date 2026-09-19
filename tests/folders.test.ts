import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkFolderName,
  folderMeta,
  folderOrder,
  groupSets,
  MAX_FOLDER_NAME,
  type Folder,
} from '../src/core/folders';

/**
 * Folders (NOTES §47).
 *
 * The owner: *"it would be cool if the users can add folders and put the
 * flashcards inside the folder for easier groupings and cleaner look."*
 */

const MIGRATION = readFileSync(
  'supabase/migrations/0024_folders_unsend_and_streak_restores.sql',
  'utf8',
);

const folder = (id: string, name: string, created = '2026-09-01T00:00:00Z'): Folder => ({
  id,
  name,
  created_at: created,
});

const set = (id: string, folder_id: string | null = null) => ({ id, folder_id });

describe('naming a folder', () => {
  it('takes a name and trims it', () => {
    expect(checkFolderName('  Anatomy  ')).toEqual({ ok: true, name: 'Anatomy' });
  });

  it('refuses nothing at all', () => {
    for (const blank of ['', '   ', '\n']) expect(checkFolderName(blank).ok).toBe(false);
  });

  it('refuses one longer than the database will take', () => {
    expect(checkFolderName('a'.repeat(MAX_FOLDER_NAME)).ok).toBe(true);
    expect(checkFolderName('a'.repeat(MAX_FOLDER_NAME + 1)).ok).toBe(false);
  });

  it('agrees with the column the database checks', () => {
    expect(MIGRATION).toContain(`length(btrim(name)) between 1 and ${MAX_FOLDER_NAME}`);
  });

  it('refuses a name already used, whatever the capitals', () => {
    const existing = [folder('f1', 'Anatomy')];
    expect(checkFolderName('anatomy', existing).ok).toBe(false);
    expect(checkFolderName('ANATOMY', existing).ok).toBe(false);
    expect(checkFolderName('Anatomy 2', existing).ok).toBe(true);
  });

  it('is case-insensitive because the database is', () => {
    expect(MIGRATION).toContain('unique (user_id, lower(name))');
  });
});

describe('a folder is a label, not a container', () => {
  it('deleting one must NOT delete the sets in it', () => {
    // The single most destructive thing in 0024 if it is written the other way:
    // somebody tidying up their groupings would lose every set in the folder,
    // with its cards, answers and review dates, and find out afterwards.
    expect(MIGRATION).toMatch(
      /folder_id uuid references public\.folders \(id\) on delete set null/,
    );
    expect(MIGRATION).not.toMatch(/folders \(id\) on delete cascade/);
  });
});

describe('arranging sets into folders', () => {
  const folders = [folder('f1', 'Anatomy'), folder('f2', 'Biology')];

  it('puts each set where it belongs, and the rest on their own', () => {
    const grouped = groupSets(
      [set('a', 'f1'), set('b', null), set('c', 'f2'), set('d', 'f1')],
      folders,
    );
    expect(grouped.folders[0]!.sets.map((s) => s.id)).toEqual(['a', 'd']);
    expect(grouped.folders[1]!.sets.map((s) => s.id)).toEqual(['c']);
    expect(grouped.loose.map((s) => s.id)).toEqual(['b']);
  });

  it('keeps the order it was given, rather than sorting', () => {
    // `dueFirst` decides what leads on Home. Sorting here would override a
    // decision made somewhere that knows more.
    const grouped = groupSets([set('z', 'f1'), set('a', 'f1')], folders);
    expect(grouped.folders[0]!.sets.map((s) => s.id)).toEqual(['z', 'a']);
  });

  it('keeps an empty folder', () => {
    // One you have just made is empty, and a folder that vanishes when its last
    // set leaves is one you cannot put anything back into.
    const grouped = groupSets([set('a', 'f1')], folders);
    expect(grouped.folders[1]!.sets).toEqual([]);
  });

  it('never loses a set whose folder has gone', () => {
    // A real state for a moment: deleting a folder nulls its sets' folder_id,
    // and the two queries can land either way round. Falling back to loose
    // shows the set; dropping it would make a set disappear from Home.
    const grouped = groupSets([set('a', 'deleted-folder'), set('b')], folders);
    expect(grouped.loose.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('treats a set with no folder column at all as loose', () => {
    // Before 0024, `listSets` cannot ask for folder_id and leaves it undefined.
    const grouped = groupSets([{ id: 'a' }], folders);
    expect(grouped.loose.map((s) => s.id)).toEqual(['a']);
  });
});

describe('the order folders appear in', () => {
  it('is by name, so the list does not move as sets go in and out', () => {
    const ordered = folderOrder([folder('f1', 'Zoology'), folder('f2', 'anatomy'), folder('f3', 'Biology')]);
    expect(ordered.map((f) => f.name)).toEqual(['anatomy', 'Biology', 'Zoology']);
  });

  it('says the same thing wherever it runs', () => {
    const src = readFileSync('src/core/folders.ts', 'utf8');
    expect(src).not.toContain('.localeCompare');
  });
});

describe('what a folder row says', () => {
  it('counts the sets, and the work inside', () => {
    expect(folderMeta(0, 0)).toBe('No sets in here yet');
    expect(folderMeta(1, 0)).toBe('1 set');
    expect(folderMeta(3, 0)).toBe('3 sets');
    // Collapsed by default, so the row has to carry the fact that there is work
    // in there — a folder that silently hid five due cards would make the count
    // on Home wrong in the only way that matters.
    expect(folderMeta(3, 5)).toBe('3 sets · 5 due');
  });
});
