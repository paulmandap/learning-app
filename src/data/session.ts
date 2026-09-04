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

/** Wire Supabase auth events into the store. Called once from the root layout. */
export function startSessionListener(): () => void {
  const { setSession, markReady } = useSessionStore.getState();

  void supabase.auth.getSession().then(({ data }) => {
    setSession(data.session);
    markReady();
  });

  const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
    setSession(session);
    markReady();
  });

  return () => sub.subscription.unsubscribe();
}
