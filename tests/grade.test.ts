import { describe, expect, it } from 'vitest';
import {
  CORRECT_THRESHOLD,
  gradeMultipleChoice,
  gradeWritten,
  isAnswerSubstantive,
  missedRetryOrder,
  PARTIAL_THRESHOLD,
  resultFor,
  shuffleOptions,
  trimFeedback,
} from '../src/core/grade';

const expected = [
  { id: 'c1', text: 'occurs in the cytoplasm' },
  { id: 'c2', text: 'does not require oxygen' },
  { id: 'c3', text: 'produces two ATP' },
  { id: 'c4', text: 'splits glucose into pyruvate' },
  { id: 'c5', text: 'is anaerobic' },
];

describe('resultFor thresholds', () => {
  it('applies the spec bands: >=80% correct, >=40% partial', () => {
    expect(resultFor(5, 5)).toBe('correct');
    expect(resultFor(4, 5)).toBe('correct'); // exactly 80%
    expect(resultFor(3, 5)).toBe('partial'); // 60%
    expect(resultFor(2, 5)).toBe('partial'); // exactly 40%
    expect(resultFor(1, 5)).toBe('incorrect'); // 20%
    expect(resultFor(0, 5)).toBe('incorrect');
  });

  it('is exact at the boundaries, not approximate', () => {
    expect(resultFor(CORRECT_THRESHOLD * 10, 10)).toBe('correct');
    expect(resultFor(PARTIAL_THRESHOLD * 10, 10)).toBe('partial');
  });

  it('never divides by zero', () => {
    expect(resultFor(0, 0)).toBe('incorrect');
  });
});

describe('gradeWritten', () => {
  it('scores hits out of the expected concepts', () => {
    const g = gradeWritten({
      expected,
      conceptsHit: ['c1', 'c2', 'c4', 'c5'],
      feedback: 'Good — you missed the ATP yield.',
    });
    expect(g.score).toBe(4);
    expect(g.maxScore).toBe(5);
    expect(g.result).toBe('correct');
    expect(g.missed).toEqual(['c3']);
  });

  it('reports which concepts were missed, for the results screen', () => {
    const g = gradeWritten({ expected, conceptsHit: ['c1'], feedback: '' });
    expect(g.hit).toEqual(['c1']);
    expect(g.missed).toEqual(['c2', 'c3', 'c4', 'c5']);
    expect(g.result).toBe('incorrect');
  });

  it('IGNORES concept ids the model invented', () => {
    // A model echoing plausible ids must not be able to award itself marks.
    const g = gradeWritten({
      expected,
      conceptsHit: ['c1', 'c99', 'made-up', ''],
      feedback: '',
    });
    expect(g.score).toBe(1);
    expect(g.hit).toEqual(['c1']);
  });

  it('does not double-count a repeated concept id', () => {
    const g = gradeWritten({ expected, conceptsHit: ['c1', 'c1', 'c1'], feedback: '' });
    expect(g.score).toBe(1);
  });

  it('handles an empty rubric without dividing by zero', () => {
    const g = gradeWritten({ expected: [], conceptsHit: [], feedback: '' });
    expect(g.result).toBe('incorrect');
    expect(g.maxScore).toBe(0);
  });
});

describe('gradeMultipleChoice', () => {
  const options = [
    { text: 'The cytoplasm', correct: true },
    { text: 'The nucleus', correct: false },
    { text: 'The mitochondrial matrix', correct: false },
  ];

  it('is decided in code, with no model involved', () => {
    expect(gradeMultipleChoice(options, 0).result).toBe('correct');
    expect(gradeMultipleChoice(options, 1).result).toBe('incorrect');
  });

  it('treats no selection or a bad index as incorrect, never as a crash', () => {
    expect(gradeMultipleChoice(options, -1).result).toBe('incorrect');
    expect(gradeMultipleChoice(options, 99).result).toBe('incorrect');
  });

  it('scores out of one', () => {
    const g = gradeMultipleChoice(options, 0);
    expect(g.score).toBe(1);
    expect(g.maxScore).toBe(1);
  });
});

describe('trimFeedback', () => {
  it('keeps at most two sentences (D6)', () => {
    const long = 'One. Two. Three. Four.';
    expect(trimFeedback(long)).toBe('One. Two.');
  });

  it('leaves short feedback alone', () => {
    expect(trimFeedback('Close, but you missed the ATP yield.')).toBe(
      'Close, but you missed the ATP yield.',
    );
  });

  it('collapses whitespace and survives empty input', () => {
    expect(trimFeedback('  a   b  ')).toBe('a b');
    expect(trimFeedback('')).toBe('');
  });

  it('handles feedback with no terminating punctuation', () => {
    expect(trimFeedback('no full stop here')).toBe('no full stop here');
  });
});

describe('shuffleOptions', () => {
  const options = ['a', 'b', 'c', 'd'];

  it('is stable for the same item, so answers do not move between views', () => {
    expect(shuffleOptions(options, 'item-1')).toEqual(shuffleOptions(options, 'item-1'));
  });

  it('differs between items, so position carries no information', () => {
    const orders = new Set(
      ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'].map((s) => shuffleOptions(options, s).join('')),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it('keeps every option exactly once', () => {
    expect([...shuffleOptions(options, 'x')].sort()).toEqual([...options].sort());
  });

  it('does not mutate the input', () => {
    const input = [...options];
    shuffleOptions(input, 'x');
    expect(input).toEqual(options);
  });
});

describe('isAnswerSubstantive', () => {
  it('gates empty or throwaway answers before spending a model call', () => {
    expect(isAnswerSubstantive('')).toBe(false);
    expect(isAnswerSubstantive('   ')).toBe(false);
    expect(isAnswerSubstantive('?')).toBe(false);
  });

  it('accepts a real attempt', () => {
    expect(isAnswerSubstantive('in the cytoplasm')).toBe(true);
    expect(isAnswerSubstantive('ATP')).toBe(true);
  });
});

describe('missedRetryOrder', () => {
  it('puts the most-missed first', () => {
    const items = [
      { id: 'a', misses: 1, lastAttemptAt: '2026-09-01T00:00:00Z' },
      { id: 'b', misses: 4, lastAttemptAt: '2026-09-01T00:00:00Z' },
      { id: 'c', misses: 2, lastAttemptAt: '2026-09-01T00:00:00Z' },
    ];
    expect(missedRetryOrder(items).map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties by least recently seen', () => {
    const items = [
      { id: 'recent', misses: 2, lastAttemptAt: '2026-09-03T00:00:00Z' },
      { id: 'stale', misses: 2, lastAttemptAt: '2026-09-01T00:00:00Z' },
    ];
    expect(missedRetryOrder(items).map((i) => i.id)).toEqual(['stale', 'recent']);
  });

  it('treats never-attempted as oldest', () => {
    const items = [
      { id: 'seen', misses: 1, lastAttemptAt: '2026-09-03T00:00:00Z' },
      { id: 'never', misses: 1, lastAttemptAt: null },
    ];
    expect(missedRetryOrder(items)[0]!.id).toBe('never');
  });
});
