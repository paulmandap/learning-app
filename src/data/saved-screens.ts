import { dehydrate, hydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query';
import {
  buildIdFrom,
  packSavedScreens,
  SAVED_SCREENS_KEY,
  shouldKeep,
  unpackSavedScreens,
} from '../core/saved-screens';

/**
 * Home, Progress, Notes and Profile as they last were, kept on this device
 * (NOTES §71). What is kept, and what never is, is decided in
 * `src/core/saved-screens.ts`; this file only reads and writes it.
 *
 * Per person, in one slot: put back only for whoever saved it, and removed when
 * they sign out, use Delete my data, or someone else signs in — the same promise
 * the profile picture makes (`avatar-cache.ts`).
 *
 * Best effort throughout: storage that is full, private or missing costs the
 * speed-up, never the screen.
 */

/** How long after an answer arrives the copy is written: one write for a burst of them. */
const SAVE_DELAY_MS = 1000;

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function thisBuild(): string {
  try {
    return typeof document === 'undefined' ? 'dev' : buildIdFrom(Array.from(document.scripts, (s) => s.src));
  } catch {
    return 'dev';
  }
}

/**
 * Put back what this person's screens showed last time.
 *
 * Called once, with the first answer about who is signed in, before the first
 * screen's queries are allowed to run — so they start from the copy, and the
 * requests they make refresh it. Signed out, any copy is removed: nobody is
 * signed in, so nobody's data stays. Returns whether anything was put back.
 */
export function restoreSavedScreens(client: QueryClient, userId: string | null): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const raw = store.getItem(SAVED_SCREENS_KEY);
    if (raw === null) return false;
    const state = userId ? unpackSavedScreens(raw, { userId, build: thisBuild(), now: Date.now() }) : null;
    if (!state) {
      store.removeItem(SAVED_SCREENS_KEY);
      return false;
    }
    hydrate(client, state);
    return true;
  } catch (err) {
    console.warn(`[saved screens] could not put back the copy: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** The answers this device keeps, as they are in the cache now. */
export function screensToKeep(client: QueryClient): DehydratedState {
  return dehydrate(client, {
    shouldDehydrateQuery: (query) => query.state.status === 'success' && shouldKeep(query.queryKey),
  });
}

/**
 * Keep the copy up to date as answers arrive. Returns the function that stops it.
 *
 * `signedInAs` is asked at the moment of writing, so a write still waiting when
 * somebody signs out writes nothing.
 */
export function keepSavingScreens(client: QueryClient, signedInAs: () => string | null): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const save = () => {
    timer = null;
    const userId = signedInAs();
    const store = storage();
    if (!userId || !store) return;
    try {
      const packed = packSavedScreens({ userId, build: thisBuild(), savedAt: Date.now(), state: screensToKeep(client) });
      if (packed) store.setItem(SAVED_SCREENS_KEY, packed);
      else store.removeItem(SAVED_SCREENS_KEY);
    } catch (err) {
      console.warn(`[saved screens] could not keep a copy on this device: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (!shouldKeep(event.query.queryKey)) return;
    if (timer === null) timer = setTimeout(save, SAVE_DELAY_MS);
  });

  // An iPhone can end a Home Screen app soon after it leaves the screen, so a
  // write that is still waiting happens as it goes.
  const flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    save();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  const canListen = typeof document !== 'undefined' && typeof window !== 'undefined';
  if (canListen) {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
  }

  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    if (canListen) {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    }
  };
}

/** Remove the copy — on signing out, on Delete my data, and when the person changes. */
export function forgetSavedScreens(): void {
  try {
    storage()?.removeItem(SAVED_SCREENS_KEY);
  } catch {
    // Nothing kept, or nowhere to keep it: nothing to remove.
  }
}
