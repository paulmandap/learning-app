import { create } from 'zustand';
import type { FinishedRound, FinishReaction } from '../core/celebrate';

/**
 * The last round of studying that ended, for Nomi on Home to react to when the
 * student comes back to it, and for Nomi not to say the same words at the end of
 * the next one (NOTES §45).
 *
 * `NomiFinish` records it — the one place a round is known to be over — and
 * Home reads it on coming into view. Kept in memory only: "just finished" does
 * not outlive closing the app, and nothing about it needs saving.
 */
interface LastRoundStore {
  round: FinishedRound | null;
  /** When Nomi on Home last reacted to a round. */
  reactedAt: number | null;
  /** What Nomi said when the last round ended. */
  line: string | null;
  finished: (reaction: FinishReaction, line: string) => void;
  reacted: () => void;
}

export const useLastRound = create<LastRoundStore>((set) => ({
  round: null,
  reactedAt: null,
  line: null,
  finished: (reaction, line) => set({ round: { reaction, at: Date.now() }, line }),
  reacted: () => set({ reactedAt: Date.now() }),
}));
