/**
 * How Nomi reacts when a round of studying ends (NOTES §43).
 *
 * Pure. `encouraging` and `success` were built into `src/core/nomi-motion.ts`
 * and deliberately unused, with the streak pet doing the celebrating (NOTES
 * §35.5). The owner reversed that on 2026-09-14 — *"i never see nomi doing the
 * interactions like … encouraging, success"* — and chose the narrower of the
 * options offered: Nomi reacts when a flashcard deck, a quiz or a round of
 * fill-in-the-blanks is FINISHED, never to each answer. The pet keeps the
 * streak.
 *
 * Success at seven in ten or better; encouragement below it. Encouragement is
 * not a consolation prize — a rough round is exactly when a companion should
 * say something.
 */
import type { NomiState } from './nomi-motion';

/** The share right, from here up, that Nomi celebrates. */
export const CELEBRATE_FROM = 0.7;

export type FinishReaction = Extract<NomiState, 'success' | 'encouraging'>;

/** Nomi's reaction to a finished round, or null when nothing was answered. */
export function finishReaction(right: number, total: number): FinishReaction | null {
  if (!(total > 0) || right < 0) return null;
  return right / total >= CELEBRATE_FROM ? 'success' : 'encouraging';
}

/** What Nomi says with it. Short: the score is already on the screen. */
export function finishLine(reaction: FinishReaction, right: number, total: number): string {
  if (reaction === 'success') {
    return right === total ? 'Every one! Nicely done.' : 'Nicely done — that went well.';
  }
  return right === 0 ? "A tough one. Let's go again — it sticks the second time." : 'Good effort. The ones you missed will come back round.';
}
