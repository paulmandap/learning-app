/**
 * Quiz scoring (spec §3.2.5). Deterministic — the model never decides a score.
 *
 * The division of labour matters: Gemini reads a written answer and says WHICH
 * expected concepts it found. The arithmetic, the thresholds, and the verdict
 * are all computed here, so the same answer always scores the same and a model
 * cannot mark itself generously.
 *
 * Multiple choice never involves the model at all.
 */

import { normalize } from './text';

export type AttemptResult = 'correct' | 'partial' | 'incorrect';

/** Spec §3.2.5: correct ≥ 80%, partial ≥ 40%, otherwise incorrect. */
export const CORRECT_THRESHOLD = 0.8;
export const PARTIAL_THRESHOLD = 0.4;

export interface ExpectedConcept {
  id: string;
  text: string;
}

export interface GradedAnswer {
  result: AttemptResult;
  score: number;
  maxScore: number;
  /** Concept ids the answer covered. */
  hit: string[];
  /** Concept ids it did not — this is what the results screen shows to work on. */
  missed: string[];
  feedback: string;
}

/** Verdict from a fraction. Shared by written and multiple-choice paths. */
export function resultFor(score: number, maxScore: number): AttemptResult {
  if (maxScore <= 0) return 'incorrect';
  const ratio = score / maxScore;
  if (ratio >= CORRECT_THRESHOLD) return 'correct';
  if (ratio >= PARTIAL_THRESHOLD) return 'partial';
  return 'incorrect';
}

/**
 * Turn the model's concept list into a score.
 *
 * Defensive by design: the model returns concept IDs, and anything it invents
 * or repeats is discarded rather than counted. A model that echoed every id it
 * could imagine would otherwise score full marks on an empty answer.
 */
export function gradeWritten(input: {
  expected: ExpectedConcept[];
  conceptsHit: string[];
  feedback: string;
}): GradedAnswer {
  const validIds = new Set(input.expected.map((c) => c.id));

  const hit = [...new Set(input.conceptsHit)].filter((id) => validIds.has(id));
  const missed = input.expected.map((c) => c.id).filter((id) => !hit.includes(id));

  const maxScore = input.expected.length;
  const score = hit.length;

  return {
    result: resultFor(score, maxScore),
    score,
    maxScore,
    hit,
    missed,
    feedback: trimFeedback(input.feedback),
  };
}

/**
 * Grade a multiple-choice answer. No model call — the correct option is known.
 */
export function gradeMultipleChoice(
  options: { text: string; correct: boolean }[],
  chosenIndex: number,
): GradedAnswer {
  const chosen = options[chosenIndex];
  const isCorrect = chosen?.correct === true;

  return {
    result: isCorrect ? 'correct' : 'incorrect',
    score: isCorrect ? 1 : 0,
    maxScore: 1,
    hit: [],
    missed: [],
    feedback: '',
  };
}

/**
 * Keep feedback to at most two sentences (spec D6).
 *
 * Enforced here rather than trusted to the prompt: a rule with no check behind
 * it is a wish, and long feedback on a flashcard-sized screen is unreadable.
 */
export function trimFeedback(feedback: string): string {
  const clean = feedback.trim().replace(/\s+/g, ' ');
  if (clean.length === 0) return '';

  // Each captured sentence keeps the space that preceded it, so trim before
  // joining — otherwise "One. Two." comes back as "One.  Two.".
  const sentences = (clean.match(/[^.!?]+[.!?]*/g) ?? [clean]).map((s) => s.trim());
  return sentences.slice(0, 2).join(' ').trim();
}

/**
 * Deterministic option order (spec §3.3: "MC shuffle" is code's job).
 *
 * Seeded by the item id so the same card presents its options the same way
 * every time — a student re-reading a card should not see the answer jump
 * position, which would teach them the position rather than the fact.
 */
export function shuffleOptions<T>(options: T[], seed: string): T[] {
  return shuffleSeeded(options, seed);
}

/**
 * The shuffle underneath, for anything that needs a repeatable random order.
 *
 * Two callers want opposite things from the same function, which is why the
 * seed is a parameter rather than a clock:
 *
 *  - `shuffleOptions` seeds with the item id, so an order that must NOT change
 *    between two viewings of one card;
 *  - the quiz seeds with the moment the round started, so an order that DOES
 *    change every time you open it.
 *
 * Deterministic either way, so a given seed can be reproduced in a test.
 */
export function shuffleSeeded<T>(options: T[], seed: string): T[] {
  const out = [...options];
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Fisher-Yates driven by a small deterministic PRNG.
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    const j = Math.abs(h) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Is a typed answer close enough to be worth grading at all?
 *
 * Cheap pre-check so an empty or one-word throwaway does not spend a model
 * call. Not a grade — just a gate.
 */
export function isAnswerSubstantive(answer: string): boolean {
  return normalize(answer).replace(/[^\p{L}\p{N} ]/gu, '').trim().length >= 2;
}

/**
 * Order for retrying missed items.
 *
 * Most-missed first, then least recently seen. Retention comes from the missed
 * loop (D8), so the ordering is deliberate rather than incidental.
 */
export function missedRetryOrder<T extends { misses: number; lastAttemptAt: string | null }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    if (b.misses !== a.misses) return b.misses - a.misses;
    const at = a.lastAttemptAt ? Date.parse(a.lastAttemptAt) : 0;
    const bt = b.lastAttemptAt ? Date.parse(b.lastAttemptAt) : 0;
    return at - bt;
  });
}
