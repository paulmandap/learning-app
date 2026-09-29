import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { crossedClue, crossOut, givesAway, HINT_AFTER_MS, pointsClue, quickClue } from '../src/core/hints';
import { NEW_CARD, nextState, type ReviewState } from '../src/core/schedule';
import { askForHint } from '../src/data/hints';
import type { Db } from '../src/data/supabase';

/**
 * Hints when the student is stuck (NOTES §69) — the owner's four choices, each
 * held: 20 seconds, Nomi asks and the hint shows on a tap, a quick clue first
 * and a bigger one from Gemini, right-after-a-hint counts as right but comes
 * back sooner.
 */

describe('the quick clue', () => {
  it('a one-word answer: its first letter and length', () => {
    expect(quickClue('Mitochondria')).toBe('It starts with “M”. One word, 12 letters.');
    expect(quickClue('ATP.')).toBe('It starts with “A”. One word, 3 letters.');
  });

  it('a short phrase: first letter and each word’s length', () => {
    expect(quickClue('cell membrane')).toBe('It starts with “C”. Two words: 4 and 8 letters.');
  });

  it('past a leading "the" — "starts with T" helped nobody (hint-probe, first run)', () => {
    expect(quickClue('The mesophyll.')).toBe('It starts with “M”. One word, 9 letters.');
    expect(quickClue('the Krebs cycle')).toBe('It starts with “K”. Two words: 5 and 5 letters.');
    expect(quickClue('The root collar.')).toBe('It starts with “R”. Two words: 4 and 6 letters.');
  });

  it('a sentence: the first letter of each word, as a passage is learnt by heart', () => {
    expect(quickClue('It serves as the primary photosynthetic organ.')).toBe(
      'The first letter of each word: I, s, a, t, p, p, o.',
    );
    // Twelve at most.
    expect(quickClue('one two three four five six seven eight nine ten eleven twelve thirteen')).toBe(
      'The first letter of each word: o, t, t, f, f, s, s, e, n, t, e, t, …',
    );
  });

  it('nothing to go on is no clue', () => {
    expect(quickClue('')).toBeNull();
    expect(quickClue('   ')).toBeNull();
  });

  it('a written answer: how many points to make', () => {
    expect(pointsClue(3)).toBe('A good answer covers 3 points.');
    expect(pointsClue(1)).toBe('A good answer makes one main point.');
    expect(pointsClue(0)).toBeNull();
  });
});

describe('crossing out choices', () => {
  const four = [{ correct: false }, { correct: true }, { correct: false }, { correct: false }];

  it('crosses out every wrong choice but one, never the right one', () => {
    const out = crossOut(four, 'card-1');
    expect(out.size).toBe(2);
    expect(out.has(1)).toBe(false);
  });

  it('the same ones for the same card, every time', () => {
    expect([...crossOut(four, 'card-1')]).toEqual([...crossOut(four, 'card-1')]);
  });

  it('three choices lose one; two lose none', () => {
    expect(crossOut([{ correct: true }, { correct: false }, { correct: false }], 'x').size).toBe(1);
    expect(crossOut([{ correct: true }, { correct: false }], 'x').size).toBe(0);
  });

  it('says how many, in words', () => {
    expect(crossedClue(2)).toBe('Two wrong answers are crossed out.');
    expect(crossedClue(1)).toBe('One wrong answer is crossed out.');
    expect(crossedClue(0)).toBeNull();
  });
});

describe('a bigger hint that gives the answer away is not shown', () => {
  it('holding the whole answer', () => {
    expect(givesAway('It is the cell membrane, of course.', 'cell membrane')).toBe(true);
  });

  it('holding a real word of a short answer, even changed a little', () => {
    expect(givesAway('Think of the mitochondrion — the powerhouse.', 'Mitochondria')).toBe(true);
    expect(givesAway('Think about which cycles make energy.', 'Krebs cycle')).toBe(true);
  });

  it('a nudge that does not', () => {
    expect(givesAway('It is the part of the cell that makes most of its energy.', 'Mitochondria')).toBe(false);
    // Small words of the answer do not count: "the" is in every hint.
    expect(givesAway('Think about what the question says about energy.', 'the Krebs cycle')).toBe(false);
  });

  it('a longer answer: whole, two key words together, or a long distinctive word', () => {
    const answer = 'The mitochondria make energy for the cell by breaking down glucose';
    expect(givesAway('Think about where the cell gets energy from glucose.', answer)).toBe(false);
    expect(givesAway(`So: ${answer}.`, answer)).toBe(true);
    // The one that got through on the first run of scripts/hint-probe.ts.
    expect(givesAway('The root collar marks this transition area.', 'The root collar, marked by a dashed line.')).toBe(true);
    expect(givesAway('It is the photosynthetic part.', 'It serves as the primary photosynthetic organ.')).toBe(true);
    expect(givesAway('Think about how plants use sunlight to make food.', 'They serve as the primary photosynthetic organ.')).toBe(false);
  });
});

describe('scoring after a hint', () => {
  const seen: ReviewState = { reps: 3, intervalDays: 12, ease: 2.4, lapses: 1 };
  const now = Date.parse('2026-09-29T10:00:00Z');

  it('right after a hint comes back sooner, with the streak and ease where they were', () => {
    const hinted = nextState(seen, 'correct', now, { hinted: true });
    expect(hinted.intervalDays).toBe(6);
    expect(hinted.reps).toBe(3);
    expect(hinted.ease).toBe(2.4);
    expect(hinted.lapses).toBe(1);
    // Right without one moves on as before.
    const clean = nextState(seen, 'correct', now);
    expect(clean.intervalDays).toBeGreaterThan(hinted.intervalDays);
    expect(clean.reps).toBe(4);
  });

  it('a brand-new card right after a hint is back tomorrow', () => {
    expect(nextState(NEW_CARD, 'correct', now, { hinted: true }).intervalDays).toBe(1);
  });

  it('wrong is wrong, hint or not', () => {
    expect(nextState(seen, 'incorrect', now, { hinted: true })).toEqual(nextState(seen, 'incorrect', now));
  });

  it('the answer is still recorded as right — only the schedule changes', () => {
    const attempts = readFileSync('src/data/attempts.ts', 'utf8');
    expect(attempts).toContain('nextState(prev, input.result, Date.now(), { hinted: input.hinted })');
    expect(attempts).toContain('lastResult: input.result,');
  });
});

describe('asking Gemini for a bigger hint', () => {
  const card = { question: 'What makes most of a cell’s energy?', answer: 'Mitochondria', source: '' };
  const db = (remaining: number) => ({ rpc: vi.fn(async () => ({ data: remaining, error: null })) }) as unknown as Db;
  const now = <T,>(task: () => Promise<T>) => task();

  it('says to add a key, and calls nothing, without one', async () => {
    const hint = vi.fn();
    const reply = await askForHint({ ...card, apiKey: '' }, { db: db(5), provider: { hint }, run: now });
    expect(reply.ok).toBe(false);
    expect(hint).not.toHaveBeenCalled();
  });

  it('spends one of the day’s replies, and stops when they are gone', async () => {
    const hint = vi.fn();
    const reply = await askForHint({ ...card, apiKey: 'k' }, { db: db(-1), provider: { hint }, run: now });
    expect(reply).toMatchObject({ ok: false });
    expect(hint).not.toHaveBeenCalled();
  });

  it('shows a hint that points the way', async () => {
    const hint = vi.fn(async () => 'It is the part of the cell that works like a power station.');
    const reply = await askForHint({ ...card, apiKey: 'k' }, { db: db(20), provider: { hint }, run: now });
    expect(reply).toEqual({ ok: true, hint: 'It is the part of the cell that works like a power station.', note: null });
  });

  it('never one that gives the answer away', async () => {
    const hint = vi.fn(async () => 'Think of the mitochondrion.');
    const reply = await askForHint({ ...card, apiKey: 'k' }, { db: db(20), provider: { hint }, run: now });
    expect(reply.ok).toBe(false);
  });

  it('busy is said as busy', async () => {
    const hint = vi.fn(async () => {
      throw new Error('boom');
    });
    const reply = await askForHint({ ...card, apiKey: 'k' }, { db: db(20), provider: { hint }, run: now });
    expect(reply).toEqual({ ok: false, message: 'Gemini is busy right now — try again in a minute.' });
  });
});

describe('on the three study screens', () => {
  const read = (f: string) => readFileSync(f, 'utf8');

  it('waits 20 seconds on one card', () => {
    expect(HINT_AFTER_MS).toBe(20_000);
    expect(read('src/ui/hint.tsx')).toContain('export function useStuck(key: string, active: boolean, ms = HINT_AFTER_MS)');
  });

  it('Nomi asks, and nothing shows until the tap — which is when the hint counts', () => {
    const hint = read('src/ui/hint.tsx');
    expect(hint).toContain('Want a hint?');
    // The screen hears of it only from the tap.
    expect(hint.match(/spec\.onShown\(\)/g)).toHaveLength(1);
    expect(hint).toMatch(/const show = \(\) => \{\s*setOpen\(true\);\s*spec\.onShown\(\);/);
    expect(read('src/ui/nomi-studying.tsx')).toContain('onOffered={() => setIdea(true)}');
  });

  it('every screen offers one and records a right answer after it as hinted', () => {
    for (const screen of ['flashcards', 'quiz', 'blanks']) {
      const src = read(`app/set/[id]/${screen}.tsx`);
      expect(src, screen).toMatch(/<StudyProgress[\s\S]*?hint=\{\{/);
      expect(src, screen).toMatch(/hinted: (hinted\.has\(card\.id\)|hintShown),/);
    }
  });

  it('the quiz crosses choices out and keeps them unpickable', () => {
    const quiz = read('app/set/[id]/quiz.tsx');
    expect(quiz).toContain('crossOut(options, item.id)');
    expect(quiz).toContain("textDecorationLine: out ? 'line-through' : 'none'");
    expect(quiz).toContain('onPress={() => !current && !out && setChosen(i)}');
  });

  it('a blank’s bigger hint is never asked with the notes’ sentence, which is the answer', () => {
    expect(read('app/set/[id]/blanks.tsx')).toContain(
      "bigger: { question: current.cloze.text, answer: current.cloze.answer, source: '' },",
    );
  });
});
