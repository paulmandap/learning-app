import { describe, expect, it } from 'vitest';
import { missedRetryOrder, resultFor } from '../src/core/grade';

/**
 * The come-back loop (D8): "Retention comes from the missed loop, not from
 * generation." These pin the rules that decide what comes back and in what
 * order — the database queries that use them are covered by the isolation
 * script against the live project.
 */

type Stat = {
  id: string;
  misses: number;
  lastAttemptAt: string | null;
  lastResult: 'correct' | 'partial' | 'incorrect' | null;
};

/** Mirrors missedItemIds(): the pile keys on the LAST result, not on history. */
function missedPile(stats: Stat[]): string[] {
  return stats
    .filter((s) => s.lastResult === 'incorrect' || s.lastResult === 'partial')
    .map((s) => s.id);
}

describe('the missed pile', () => {
  it('includes anything last answered wrongly or partly', () => {
    const pile = missedPile([
      { id: 'wrong', misses: 1, lastAttemptAt: null, lastResult: 'incorrect' },
      { id: 'partial', misses: 1, lastAttemptAt: null, lastResult: 'partial' },
      { id: 'right', misses: 0, lastAttemptAt: null, lastResult: 'correct' },
    ]);
    expect(pile).toEqual(['wrong', 'partial']);
  });

  it('LETS GO of a card once you get it right', () => {
    // Keyed on last result rather than "ever missed": something you got wrong
    // once and have since learned should leave the pile, or the retry list
    // grows forever and stops meaning anything.
    const learned: Stat = {
      id: 'learned',
      misses: 3,
      lastAttemptAt: '2026-09-04T00:00:00Z',
      lastResult: 'correct',
    };
    expect(missedPile([learned])).toEqual([]);
  });

  it('excludes never-attempted cards — they were not missed, just unseen', () => {
    expect(missedPile([{ id: 'new', misses: 0, lastAttemptAt: null, lastResult: null }])).toEqual(
      [],
    );
  });
});

describe('retry ordering', () => {
  it('puts the most-missed first, then the stalest', () => {
    const order = missedRetryOrder([
      { id: 'a', misses: 1, lastAttemptAt: '2026-09-01T00:00:00Z' },
      { id: 'b', misses: 3, lastAttemptAt: '2026-09-04T00:00:00Z' },
      { id: 'c', misses: 3, lastAttemptAt: '2026-09-01T00:00:00Z' },
    ]);
    expect(order.map((o) => o.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('flashcard results feed the same loop as quiz results', () => {
  it('a flashcard "Missed" is an incorrect attempt', () => {
    // Flashcards log attempts too, otherwise a card studied only in flashcards
    // could never enter the missed pile.
    expect(resultFor(0, 1)).toBe('incorrect');
    expect(resultFor(1, 1)).toBe('correct');
  });
});
