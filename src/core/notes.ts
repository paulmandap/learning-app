/**
 * Notebook rules, pure and testable (Phase 10).
 *
 * The screens hold the typing; this holds every decision about what a note is
 * called, what it looks like in a list, and whether there is enough of it to
 * make cards from. Same split as everywhere else in `src/core` — no
 * react-native import, so Vitest can reach it.
 */

/** Longest note we will hold. Generous; it exists so nothing is unbounded. */
export const MAX_NOTE_CHARS = 50_000;

/**
 * Words a note needs before cards can be made from it.
 *
 * The old deterministic estimate in D3 was roughly one card per 70 words, and
 * although that estimate is gone the shape of the problem is not: a note of a
 * dozen words cannot produce a study set, and the failure would arrive after a
 * model call, as an empty set, with nothing explaining why.
 *
 * 30 words is about two sentences — low enough not to nag someone mid-lecture,
 * high enough that the button never promises something the notes cannot
 * support. The check is a gate on the BUTTON, not on saving: half a sentence is
 * still a note, and still worth keeping.
 */
export const MIN_WORDS_FOR_CARDS = 30;

/** Words, counted the way a person would. */
export function noteWordCount(body: string): number {
  const trimmed = body.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** Is there enough here to be worth a model call? */
export function canMakeCards(body: string): boolean {
  return noteWordCount(body) >= MIN_WORDS_FOR_CARDS;
}

/**
 * What to call a note in a list.
 *
 * Falls back through: the title the student typed, then the note's own first
 * line, then a placeholder. The middle step is the one that matters — people
 * write a heading as the first line and never touch the title field, and a
 * notebook full of "Untitled note" would be unusable for exactly the person
 * who used it most naturally.
 */
export function noteTitle(note: { title: string; body: string }): string {
  const typed = note.title.trim();
  if (typed.length > 0) return typed;

  const firstLine = note.body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return 'Untitled note';
  // A whole paragraph as a title is unreadable in a row; cut it at a word.
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 57).trimEnd()}…`;
}

/**
 * The second line of a row: what this note is about, at a glance.
 *
 * Skips whatever `noteTitle` already used, so a note whose first line is its
 * heading does not show that heading twice.
 */
export function notePreview(note: { title: string; body: string }): string {
  const lines = note.body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  // If the title came from the body's first line, preview from the second.
  const skipFirst = note.title.trim().length === 0 && lines.length > 0;
  const rest = (skipFirst ? lines.slice(1) : lines).join(' ');

  if (rest.length === 0) return 'Empty';
  return rest.length <= 100 ? rest : `${rest.slice(0, 97).trimEnd()}…`;
}

/**
 * "Saved just now", "Saved 5 minutes ago".
 *
 * Someone typing in a lecture needs to believe their words are safe, and a
 * timestamp is how they check without stopping. Deliberately coarse: a counter
 * ticking every second would be one more thing moving on the screen.
 */
export function describeSaved(savedAt: number | null, now: number): string | null {
  if (savedAt === null) return null;

  const seconds = Math.max(0, Math.round((now - savedAt) / 1000));
  if (seconds < 45) return 'Saved just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Saved ${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  return `Saved ${hours} hour${hours === 1 ? '' : 's'} ago`;
}
