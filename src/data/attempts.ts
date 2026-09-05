import { supabase } from './supabase';
import { currentState, saveSchedule } from './review';
import { nextState } from '../core/schedule';
import type { AttemptResult } from '../core/grade';

/**
 * Attempts — every answer, logged (D8).
 *
 * "Retention comes from the missed loop, not from generation." One row per
 * answer is what makes the missed pile, the retry order and Home's "Continue"
 * possible, so this is written on every quiz answer without exception.
 */

export type StudyMode = 'flashcards' | 'quiz';

export interface Attempt {
  id: string;
  study_item_id: string;
  study_set_id: string;
  mode: StudyMode;
  result: AttemptResult;
  score: number | null;
  max_score: number | null;
  answer_text: string | null;
  feedback: string | null;
  created_at: string;
}

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

/**
 * Record one answer. Exactly one row per answered question.
 *
 * Also advances the card's review schedule (Phase 6). This is the right place
 * for it and the only one: every answer in the app — flashcard swipe, flashcard
 * button, keyboard shortcut, quiz submission — passes through here, so a
 * schedule cannot be forgotten by a caller that grades a card some new way.
 *
 * The schedule write is deliberately non-fatal. Losing an answer because a
 * scheduling row would not write is a bad trade, and this code ships before
 * migration 0005 has necessarily been applied.
 */
export async function recordAttempt(input: {
  studyItemId: string;
  studySetId: string;
  mode: StudyMode;
  result: AttemptResult;
  score?: number | null;
  maxScore?: number | null;
  answerText?: string | null;
  feedback?: string | null;
}): Promise<void> {
  const user_id = await currentUserId();

  const { error } = await supabase.from('attempts').insert({
    user_id,
    study_item_id: input.studyItemId,
    study_set_id: input.studySetId,
    mode: input.mode,
    result: input.result,
    score: input.score ?? null,
    max_score: input.maxScore ?? null,
    answer_text: input.answerText ?? null,
    feedback: input.feedback ?? null,
  });

  if (error) throw new Error(error.message);

  // --- advance the schedule ------------------------------------------------
  // After the attempt row, never instead of it: the attempt is the record of
  // truth and the missed pile (D8) is built from it, so it must land first.
  try {
    const prev = await currentState(input.studyItemId);
    await saveSchedule({
      userId: user_id,
      studyItemId: input.studyItemId,
      studySetId: input.studySetId,
      state: nextState(prev, input.result, Date.now()),
      lastResult: input.result,
    });
  } catch {
    // Studying continues without a schedule. See the note in src/data/review.ts
    // on why this degrades rather than throws.
  }
}

export interface ItemStat {
  study_item_id: string;
  attempts: number;
  misses: number;
  last_result: AttemptResult | null;
  last_attempt_at: string | null;
}

/**
 * Per-item history from the item_stats view.
 *
 * The view runs with security_invoker = true, so RLS applies and it returns
 * only this user's rows — the isolation test asserts that explicitly.
 */
export async function itemStatsForSet(studySetId: string): Promise<ItemStat[]> {
  const { data, error } = await supabase
    .from('item_stats')
    .select('study_item_id, attempts, misses, last_result, last_attempt_at')
    .eq('study_set_id', studySetId);

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ItemStat[];
}

/**
 * Item ids the user got wrong last time — the missed pile.
 *
 * Keyed on the LAST result rather than on ever having missed it: something you
 * got wrong once and have since learned should leave the pile.
 */
export async function missedItemIds(studySetId: string): Promise<Set<string>> {
  const stats = await itemStatsForSet(studySetId);
  return new Set(
    stats
      .filter((s) => s.last_result === 'incorrect' || s.last_result === 'partial')
      .map((s) => s.study_item_id),
  );
}

/** How many items in this set are waiting to be retried. Drives Home's "Continue". */
export async function missedCount(studySetId: string): Promise<number> {
  return (await missedItemIds(studySetId)).size;
}

export interface ContinueTarget {
  studySetId: string;
  missed: number;
  lastAttemptAt: string;
}

/**
 * The set to offer on Home, and how much is waiting in it.
 *
 * One query across all sets rather than one per set: Home must render
 * "Continue: … · 9 cards to retry" without extra taps OR a burst of requests.
 * RLS scopes item_stats to this user, so nothing is filtered client-side for
 * security — only for presentation.
 */
export async function continueTarget(): Promise<ContinueTarget | null> {
  const { data, error } = await supabase
    .from('item_stats')
    .select('study_set_id, study_item_id, last_result, last_attempt_at')
    .order('last_attempt_at', { ascending: false });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as {
    study_set_id: string;
    study_item_id: string;
    last_result: AttemptResult | null;
    last_attempt_at: string | null;
  }[];
  if (rows.length === 0) return null;

  // Most recently studied set wins — "continue" means where you left off, not
  // wherever the biggest backlog happens to be.
  const mostRecent = rows.find((r) => r.last_attempt_at !== null);
  if (!mostRecent) return null;

  const missed = rows.filter(
    (r) =>
      r.study_set_id === mostRecent.study_set_id &&
      (r.last_result === 'incorrect' || r.last_result === 'partial'),
  ).length;

  return {
    studySetId: mostRecent.study_set_id,
    missed,
    lastAttemptAt: mostRecent.last_attempt_at!,
  };
}
