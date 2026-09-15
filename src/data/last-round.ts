import { create } from 'zustand';
import type { FinishedRound, FinishReaction } from '../core/celebrate';

/**
 * The last round of studying that ended, for Nomi on Home to react to when the
 * student comes back to it (NOTES §45).
 *
 * `NomiFinish` records it — the one place a round is known to be over — and
 * Home reads it on coming into view. Kept in memory only: "just finished" does
 * not outlive closing the app, and nothing about it needs saving.
 */
interface LastRoundStore {
  round: FinishedRound | null;
  /** When Nomi on Home last reacted to a round. */
  reactedAt: number | null;
  finished: (reaction: FinishReaction) => void;
  reacted: () => void;
}

export const useLastRound = create<LastRoundStore>((set) => ({
  round: null,
  reactedAt: null,
  finished: (reaction) => set({ round: { reaction, at: Date.now() } }),
  reacted: () => set({ reactedAt: Date.now() }),
}));
