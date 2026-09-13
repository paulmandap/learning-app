import { describe, expect, it } from 'vitest';
import { busiestLevel, countByLevel, deal, isLevel, startingLevel } from '../src/core/deck';
import type { Level } from '../src/core/planner';

/**
 * Which cards a deck deals.
 *
 * Built around the state the owner's reports came from, reproduced on the test
 * account on 2026-09-13: every missed card and every due card at Remember, and
 * decks opening on Understand.
 */

interface Card {
  id: string;
  level: Level;
}

const cards: Card[] = [
  { id: 'r1', level: 'remember' },
  { id: 'r2', level: 'remember' },
  { id: 'u1', level: 'understand' },
  { id: 'a1', level: 'apply' },
];
const of = { id: (c: Card) => c.id, level: (c: Card) => c.level };

describe('deal', () => {
  it('deals one level when studying normally', () => {
    expect(deal(cards, { level: 'remember', retryOnly: false }, of).map((c) => c.id)).toEqual(['r1', 'r2']);
  });

  it('a retry deck deals every missed card, whatever level the screen is on', () => {
    // The bug: the retry deck opened on Understand, found nothing, and the
    // missed Remember cards stayed on the button that sent the student there.
    const missed = new Set(['r2', 'a1']);
    expect(deal(cards, { level: 'understand', retryOnly: true, missed }, of).map((c) => c.id)).toEqual(['r2', 'a1']);
  });

  it('a retry deck deals as many cards as the missed count promises', () => {
    const missed = new Set(['r1', 'r2', 'u1']);
    for (const level of ['remember', 'understand', 'apply'] as const) {
      expect(deal(cards, { level, retryOnly: true, missed }, of)).toHaveLength(missed.size);
    }
  });

  it('a retry deck with no missed pile loaded yet deals nothing rather than everything', () => {
    expect(deal(cards, { level: 'remember', retryOnly: true }, of)).toEqual([]);
  });
});

describe('where a deck opens', () => {
  it('busiestLevel picks the level with the most', () => {
    expect(busiestLevel({ remember: 7, understand: 2 })).toBe('remember');
    expect(busiestLevel({ understand: 1, apply: 4 })).toBe('apply');
  });

  it('breaks ties toward the easier level, so the same counts always open the same deck', () => {
    expect(busiestLevel({ remember: 3, apply: 3 })).toBe('remember');
  });

  it('has no opinion when nothing is there', () => {
    expect(busiestLevel({})).toBeNull();
    expect(busiestLevel({ remember: 0 })).toBeNull();
  });

  it('startingLevel takes a real level from the link and ignores anything else', () => {
    expect(startingLevel('apply')).toBe('apply');
    expect(startingLevel(undefined)).toBe('understand');
    expect(startingLevel('everything')).toBe('understand');
    expect(startingLevel(['remember'])).toBe('understand');
  });

  it('isLevel accepts exactly the three levels', () => {
    expect(['remember', 'understand', 'apply'].every(isLevel)).toBe(true);
    expect(isLevel('Remember')).toBe(false);
  });

  it('countByLevel counts only what it is told to', () => {
    expect(countByLevel(cards, (c) => c.level)).toEqual({ remember: 2, understand: 1, apply: 1 });
    expect(countByLevel(cards, (c) => c.level, (c) => c.id !== 'r1')).toEqual({ remember: 1, understand: 1, apply: 1 });
  });
});
