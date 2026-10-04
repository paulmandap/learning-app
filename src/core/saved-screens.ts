import type { DehydratedState, QueryKey } from '@tanstack/react-query';

/**
 * What the main screens last showed, kept on this device (NOTES §71).
 *
 * The owner: *"sometimes loading is about 2 seconds. i want my app to be
 * faster ... at the cost of the user side and minimal effect on my DB side."*
 * Measured on 2026-10-04, nothing outlived the page: every open asked the
 * database for all of Home again, and showed none of it until the answers came.
 *
 * So the answers behind Home, Progress, Notes and Profile are kept in this
 * browser's storage, and an open shows them at once while the same requests as
 * before refresh them behind. The database is asked nothing more.
 *
 * Pure: `src/data/saved-screens.ts` reads and writes the storage.
 */

/** Where the copy is kept. One slot: only the person signed in has a copy. */
export const SAVED_SCREENS_KEY = 'nomi-saved-screens';

/** Raised when what is kept changes in a way an older copy cannot be read as. */
export const SAVED_SCREENS_VERSION = 1;

/** A copy older than this is not shown: after a week it misleads more than it helps. */
export const SAVED_SCREENS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The most kept, in characters of JSON.
 *
 * A browser keeps about five million characters for a site, shared with the
 * session and the profile picture (`MAX_CACHED_PHOTO_CHARS`, 200,000). A
 * million leaves room for both. Past it, the least needed screens are given up
 * first, rather than keeping nothing.
 */
export const SAVED_SCREENS_MAX_CHARS = 1_000_000;

/**
 * How long a kept answer stays in memory unused: a day, not TanStack Query's
 * five minutes. A screen nobody has opened since launch is still there to be
 * kept the next time something is saved, instead of quietly dropping out.
 */
export const KEPT_SCREENS_GC_MS = 24 * 60 * 60 * 1000;

/**
 * What is kept, by the first part of each query's key — most needed first,
 * because a copy that is too big gives up from the end.
 *
 * Home (the snapshot behind Nomi's line and every set's bar, the sets, Continue,
 * the folders), then Progress, then Profile's own lines, then the notes, which
 * are the biggest and are read least often on opening.
 *
 * Never kept:
 *  - **The profile.** It holds the Gemini key, which lives in the database
 *    under row-level security (D12), and the Privacy Policy does not list it
 *    among what this device holds. So the first screen still waits for it: one
 *    request.
 *  - **A signed picture link.** They stop working (a post's after ten minutes).
 *  - **Anything a deck is dealt from.** Those screens ask for fresh data, and one
 *    of their queries never goes stale (`staleTime: Infinity`), so a kept copy
 *    would never be replaced.
 *  - **Other people's conversations.** Messages refresh on their own timer.
 */
export const KEPT_SCREENS = [
  'nomi-brain',
  'sets',
  'continue',
  'folders',
  'dashboard',
  'my-username',
  'my-bio',
  'post-count',
  'notes',
] as const;

const KEPT: readonly string[] = KEPT_SCREENS;

/** Whether a query's answer is one this device keeps. */
export function shouldKeep(queryKey: QueryKey): boolean {
  const root = queryKey[0];
  return typeof root === 'string' && KEPT.includes(root);
}

/** What is written to storage. */
export interface SavedScreens {
  v: number;
  /** Whose answers these are. A copy is only ever shown to the same person. */
  userId: string;
  /** The build that saved it — see `buildIdFrom`. */
  build: string;
  /** Milliseconds since 1970, when it was written. */
  savedAt: number;
  state: DehydratedState;
}

type DehydratedQueries = DehydratedState['queries'];

/**
 * A query that mentions the Gemini key is dropped whatever its name.
 *
 * Nothing kept today reads that column, so this never fires. It is here so
 * that a later change to what Home loads cannot put the key on the device
 * without a test failing first (`tests/saved-screens.test.ts`).
 */
function mentionsTheKey(query: DehydratedQueries[number]): boolean {
  try {
    return JSON.stringify(query.state.data ?? null).includes('gemini_api_key');
  } catch {
    return true;
  }
}

/**
 * The copy to write, or null when there is nothing worth keeping.
 *
 * Only what `shouldKeep` allows, only answers that arrived (`status: 'success'`),
 * never anything mentioning the key — whatever the caller passed in.
 */
export function packSavedScreens(saved: Omit<SavedScreens, 'v'>): string | null {
  let queries: DehydratedQueries = saved.state.queries.filter(
    (q) => shouldKeep(q.queryKey) && q.state.status === 'success' && !mentionsTheKey(q),
  );
  const pack = () =>
    JSON.stringify({
      v: SAVED_SCREENS_VERSION,
      userId: saved.userId,
      build: saved.build,
      savedAt: saved.savedAt,
      state: { mutations: [], queries },
    } satisfies SavedScreens);

  let text = pack();
  for (const root of [...KEPT_SCREENS].reverse()) {
    if (text.length <= SAVED_SCREENS_MAX_CHARS) break;
    queries = queries.filter((q) => q.queryKey[0] !== root);
    text = pack();
  }
  if (queries.length === 0 || text.length > SAVED_SCREENS_MAX_CHARS) return null;
  return text;
}

function isSavedScreens(value: unknown): value is SavedScreens {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<SavedScreens>;
  return (
    typeof v.v === 'number' &&
    typeof v.userId === 'string' &&
    typeof v.build === 'string' &&
    typeof v.savedAt === 'number' &&
    typeof v.state === 'object' &&
    v.state !== null &&
    Array.isArray(v.state.queries) &&
    v.state.queries.every(
      (q) =>
        typeof q === 'object' &&
        q !== null &&
        Array.isArray(q.queryKey) &&
        typeof q.queryHash === 'string' &&
        typeof q.state === 'object' &&
        q.state !== null,
    )
  );
}

/**
 * What to put back for this person, or null to show nothing.
 *
 * Null for anything doubtful: unreadable, another person's, from another build
 * (an answer's shape can change between builds, and a screen given the old
 * shape could break), older than a week, or dated in the future.
 */
export function unpackSavedScreens(
  raw: string | null,
  expected: { userId: string; build: string; now: number },
): DehydratedState | null {
  if (!raw || !expected.userId) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isSavedScreens(saved)) return null;
  if (saved.v !== SAVED_SCREENS_VERSION) return null;
  if (saved.userId !== expected.userId || saved.build !== expected.build) return null;
  const age = expected.now - saved.savedAt;
  if (age < 0 || age > SAVED_SCREENS_MAX_AGE_MS) return null;
  const queries = saved.state.queries.filter(
    (q) => shouldKeep(q.queryKey) && q.state.status === 'success' && !mentionsTheKey(q),
  );
  return queries.length === 0 ? null : { mutations: [], queries };
}

/**
 * Which build of the app this is, from the address of its main script.
 *
 * `expo export` names it `entry-<hash>.js`, and the hash changes whenever the
 * code does, so a copy saved by one build is never read by another. The first
 * open after a deploy is an ordinary one; the opens after it are quick again.
 * 'dev' when there is no such script — the dev server, and tests.
 */
export function buildIdFrom(scriptSrcs: readonly string[]): string {
  for (const src of scriptSrcs) {
    const match = /\/_expo\/static\/js\/web\/entry-([0-9a-f]+)\.js/.exec(src);
    if (match) return match[1]!;
  }
  return 'dev';
}
