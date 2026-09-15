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

// ------------------------------------------------------- what Nomi says --

/**
 * How a round went, finer than the reaction: what Nomi's words follow (NOTES
 * §45). The first three draw `success`, the last three `encouraging`, split at
 * the same 70%.
 */
export type FinishBand = 'perfect' | 'great' | 'good' | 'halfway' | 'tough' | 'none';

export function finishBand(right: number, total: number): FinishBand | null {
  if (!finishReaction(right, total)) return null;
  const share = right / total;
  if (share >= 1) return 'perfect';
  if (share >= 0.85) return 'great';
  if (share >= CELEBRATE_FROM) return 'good';
  if (share >= 0.5) return 'halfway';
  return right > 0 ? 'tough' : 'none';
}

/**
 * What Nomi says when a round ends, several ways for each band (NOTES §45).
 *
 * The owner: *"it would be cool too if nomi has some comments after the user
 * finished answering the flashcards. what nomi will say will vary per result.
 * but if the user has a not so high passing score let's say <50% nomi will
 * still be positive and cheer."* So below half every line cheers, and
 * `tests/celebrate.test.ts` holds them to it. Worded for any round — the quiz
 * and the blanks end the same way — and with no numbers: the score is beside it.
 */
export const FINISH_LINES: Readonly<Record<FinishBand, readonly string[]>> = {
  perfect: [
    'Every single one! You really know these.',
    'A perfect round — nicely done!',
    'Not one missed. Your studying is paying off!',
    "All of them! I'm doing a little happy dance.",
    'Flawless! These are really sticking.',
  ],
  great: [
    'So close to perfect — that went really well!',
    'Great round! Just a couple to look at again.',
    'You know nearly all of these now. Brilliant!',
    'Look at you go — that was a strong round!',
  ],
  good: [
    'Nicely done — that went well.',
    'Good round! The rest are almost there.',
    'Solid work. A bit more and these are all yours.',
    'Most of them stuck. Nice one!',
  ],
  halfway: [
    "More right than missed — you're getting there!",
    'Good effort! The ones you missed will come back round.',
    'Halfway there and climbing. Keep it up!',
    "You're building this up, one at a time. Nice!",
  ],
  tough: [
    "You finished the whole round — that's what counts! The rest will come.",
    "Every one you missed is one you'll know better next time. Keep going!",
    "Tough round, but you showed up and did it. I'm proud of you!",
    'Some are sticking already! Round two will feel easier, promise.',
    "This is exactly what learning looks like. Let's go again!",
  ],
  none: [
    'A tough one — but you got through all of it! It sticks the second time.',
    "Nothing stuck yet, and that's okay! You've met them all now — let's go again.",
    "First tries are for getting to know them. Next time, you'll be ready!",
    "That round put up a fight! You'll win the rematch.",
  ],
};

/**
 * One of the band's lines, picked at random and never the one Nomi said at the
 * end of the last round. `random` is passed in so this stays pure. Null when
 * nothing was answered.
 */
export function finishLine(
  right: number,
  total: number,
  random: () => number,
  lastSaid: string | null = null,
): string | null {
  const band = finishBand(right, total);
  if (!band) return null;
  const lines = FINISH_LINES[band].filter((line) => line !== lastSaid);
  const r = Math.min(0.999999, Math.max(0, random()));
  return lines[Math.floor(r * lines.length)]!;
}

// ---------------------------------------------------- back on the Nomi tab --

/**
 * How long after a round ends Nomi on Home still reacts to it (NOTES §45).
 *
 * The owner: *"if i recently finished a flashcard, when i get back to nomi tab,
 * nomi will do success animation."* Asked whether Nomi should always celebrate
 * or match how the round went, they chose to match it — the same reaction the
 * end-of-round screen shows. Once per round, and only while it is "just now".
 */
export const RETURN_REACTION_MS = 30 * 60 * 1000;

export interface FinishedRound {
  reaction: FinishReaction;
  /** When it ended, epoch ms. */
  at: number;
}

/**
 * The reaction for Nomi on Home to play now, or null: only for a round that
 * ended within `RETURN_REACTION_MS` and that Home has not reacted to yet.
 */
export function returnReaction(round: FinishedRound | null, reactedAt: number | null, now: number): FinishReaction | null {
  if (!round) return null;
  if (reactedAt !== null && reactedAt >= round.at) return null;
  if (now < round.at || now - round.at > RETURN_REACTION_MS) return null;
  return round.reaction;
}
