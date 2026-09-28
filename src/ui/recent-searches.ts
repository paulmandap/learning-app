import { addRecent, parseRecent } from '../core/profile';

/**
 * Recent searches, on this device only (NOTES §59, the owner's default) —
 * nothing about what somebody searched for is sent anywhere or kept in the
 * database. Per person, so a shared phone does not show one person's searches
 * to the next.
 *
 * Storage can be missing or refuse (a private window); then there are simply
 * no recent searches, and searching still works.
 */
function key(userId: string): string {
  return `nomi.recentSearches.${userId}`;
}

export function loadRecent(userId: string): string[] {
  try {
    return parseRecent(globalThis.localStorage?.getItem(key(userId)) ?? null);
  } catch {
    return [];
  }
}

export function rememberSearch(userId: string, term: string): string[] {
  const next = addRecent(loadRecent(userId), term);
  try {
    globalThis.localStorage?.setItem(key(userId), JSON.stringify(next));
  } catch {
    // Not kept this time; the search itself is unaffected.
  }
  return next;
}

export function clearRecent(userId: string): void {
  try {
    globalThis.localStorage?.removeItem(key(userId));
  } catch {
    // Nothing to clear, or nothing allowed.
  }
}
