import { create } from 'zustand';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

/**
 * The single Zustand store. Holds ephemeral client/session state only —
 * everything durable lives in Postgres and is read through TanStack Query.
 *
 * Auth session lives here rather than in Query because it is push-driven:
 * Supabase emits changes through a listener, it is not something we poll.
 */

interface SessionState {
  session: Session | null;
  /** False until the first auth state event lands, so we don't flash the sign-in screen. */
  ready: boolean;
  setSession: (s: Session | null) => void;
  markReady: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  session: null,
  ready: false,
  setSession: (session) => set({ session }),
  markReady: () => set({ ready: true }),
}));

/**
 * Wire Supabase auth events into the store. Called once from the root layout.
 *
 * `onFirstSession` runs once, with the first answer and before the store hears
 * it — so whatever it puts in the query cache is there before any screen's
 * queries are allowed to run (the copy kept on this device, NOTES §71).
 */
export function startSessionListener(
  options: { onFirstSession?: (session: Session | null) => void } = {},
): () => void {
  const { setSession, markReady } = useSessionStore.getState();
  let first = true;

  const settle = (session: Session | null) => {
    if (first) {
      first = false;
      try {
        options.onFirstSession?.(session);
      } catch (err) {
        console.warn(`[session] first-session step failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setSession(session);
    markReady();
  };

  void supabase.auth.getSession().then(({ data }) => settle(data.session));

  const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => settle(session));

  return () => sub.subscription.unsubscribe();
}
