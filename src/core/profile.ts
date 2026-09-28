/**
 * A profile and search — the parts decidable without a database or a screen
 * (NOTES §59, migration 0033).
 *
 * The bio's length is a COPY of 0033's check, held to it by
 * tests/profile.test.ts.
 */

/** Longest bio. Mirrors `profiles.bio`'s check (0033). */
export const BIO_MAX = 150;

export type BioCheck = { ok: true; bio: string | null } | { ok: false; reason: string };

/** Trimmed, and empty means none. One line's worth of room, not an essay. */
export function validateBio(raw: string): BioCheck {
  const bio = raw.replace(/\s+/g, ' ').trim();
  if (bio.length > BIO_MAX) return { ok: false, reason: `Keep your bio under ${BIO_MAX} characters.` };
  return { ok: true, bio: bio.length > 0 ? bio : null };
}

// ----------------------------------------------------------------- search --

/** How many recent searches the search screen keeps, on this device. */
export const RECENT_MAX = 8;

/**
 * A search just made, added to the recent ones: at the front, once (case
 * aside), and the oldest dropped past eight. Nothing under two characters —
 * that was never a search.
 */
export function addRecent(recent: readonly string[], term: string): string[] {
  const clean = term.trim();
  if (clean.length < 2) return [...recent];
  const rest = recent.filter((r) => r.toLowerCase() !== clean.toLowerCase());
  return [clean, ...rest].slice(0, RECENT_MAX);
}

/** Recent searches read back from storage: strings only, at most eight, whatever was stored. */
export function parseRecent(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/**
 * A term for a LIKE pattern, its wildcards escaped: a search for "a_b" means
 * a_b, not "a, any character, b" — the rule 0026's `search_people` follows.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** "12 posts", "1 post" — under a number on a profile. */
export function countLabel(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
