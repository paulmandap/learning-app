import { describe, expect, it } from 'vitest';
import {
  bandIndex,
  describeBand,
  describeLines,
  lineKey,
  fillQuotas,
  flattenLines,
  locateExcerpt,
  planBands,
  shareOut,
  shortfallBySection,
  splitSpans,
} from '../src/core/coverage';

/**
 * The shape of the owner's reproduction (NOTES §37): 104 short lines with no
 * full stops, where a request for 10 came back as 2 cards from lines 0 and 5.
 */
const SONG = Array.from({ length: 104 }, (_, i) => `the words of line ${i} go here`).join('\n');
const lines = flattenLines([{ page_index: 0, text: SONG }]);

describe('shareOut', () => {
  it('sums to exactly the total', () => {
    for (const total of [1, 7, 10, 60]) {
      expect(shareOut(total, [5, 3, 2, 9]).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('follows the weights', () => {
    expect(shareOut(10, [3, 1, 1])).toEqual([6, 2, 2]);
  });

  it('gives every entry its minimum when there is enough to go round', () => {
    expect(shareOut(3, [100, 1, 1], 1)).toEqual([1, 1, 1]);
  });

  it('drops the minimum rather than spending more than the total', () => {
    expect(shareOut(2, [1, 1, 1], 1).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('shares evenly when no weight is positive, and nothing when there is nothing', () => {
    expect(shareOut(4, [0, 0])).toEqual([2, 2]);
    expect(shareOut(0, [1, 2])).toEqual([0, 0]);
    expect(shareOut(5, [])).toEqual([]);
  });
});

describe('flattenLines', () => {
  it('keeps the page and line each sentence is cited by', () => {
    const out = flattenLines([{ page_index: 2, text: 'First. Second.' }]);
    expect(out.map((l) => [l.page, l.sentence, l.text])).toEqual([
      [2, 0, 'First.'],
      [2, 1, 'Second.'],
    ]);
  });

  it('limits to a span without renumbering', () => {
    const out = flattenLines([{ page_index: 0, text: SONG }], {
      from: { page: 0, sentence: 40 },
      to: { page: 0, sentence: 42 },
    });
    expect(out.map((l) => l.sentence)).toEqual([40, 41, 42]);
  });
});

describe('planBands — the whole text, not its first six lines', () => {
  it('covers every line in order, with no gap and no overlap', () => {
    const bands = planBands(lines, 10);
    expect(bands[0]!.from).toEqual({ page: 0, sentence: 0 });
    expect(bands.at(-1)!.to).toEqual({ page: 0, sentence: 103 });
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.from.sentence).toBe(bands[i - 1]!.to.sentence + 1);
    }
  });

  it('asks for exactly the total, and at least one from every part', () => {
    const bands = planBands(lines, 10);
    expect(bands).toHaveLength(9); // ceil(104 / LINES_PER_BAND)
    expect(bands.reduce((n, b) => n + b.quota, 0)).toBe(10);
    expect(bands.every((b) => b.quota >= 1)).toBe(true);
  });

  it('the reproduction: a card from line 5 belongs to the first part only', () => {
    const bands = planBands(lines, 10);
    expect(bandIndex(bands, { page: 0, sentence: 5 })).toBe(0);
    expect(bands[0]!.quota).toBeLessThanOrEqual(2);
  });

  it('never makes more parts than cards', () => {
    expect(planBands(lines, 3)).toHaveLength(3);
  });

  it('a short note is one part holding the whole request', () => {
    const three = flattenLines([{ page_index: 0, text: 'One fact. Two facts. Three facts.' }]);
    expect(planBands(three, 60)).toEqual([
      { from: { page: 0, sentence: 0 }, to: { page: 0, sentence: 2 }, quota: 60 },
    ]);
  });

  it('has nothing to plan from nothing', () => {
    expect(planBands([], 10)).toEqual([]);
    expect(planBands(lines, 0)).toEqual([]);
  });

  it('says where a citation falls, and -1 outside every part', () => {
    const bands = planBands(lines, 10);
    expect(bandIndex(bands, { page: 0, sentence: 103 })).toBe(bands.length - 1);
    expect(bandIndex(bands, { page: 1, sentence: 0 })).toBe(-1);
  });
});

describe('splitSpans', () => {
  it('cuts the lines into contiguous parts that meet end to end', () => {
    const parts = splitSpans(lines, 3);
    expect(parts).toHaveLength(3);
    expect(parts[0]!.span.from).toEqual({ page: 0, sentence: 0 });
    expect(parts[2]!.span.to).toEqual({ page: 0, sentence: 103 });
    expect(parts[1]!.span.from.sentence).toBe(parts[0]!.span.to.sentence + 1);
  });

  it('crosses pages', () => {
    const two = flattenLines([
      { page_index: 0, text: 'A one. A two.' },
      { page_index: 1, text: 'B one. B two.' },
    ]);
    const parts = splitSpans(two, 2);
    expect(parts[0]!.span).toEqual({ from: { page: 0, sentence: 0 }, to: { page: 0, sentence: 1 } });
    expect(parts[1]!.span).toEqual({ from: { page: 1, sentence: 0 }, to: { page: 1, sentence: 1 } });
  });
});

describe('describeBand', () => {
  it('names a part in the terms the numbered notes use', () => {
    expect(describeBand({ from: { page: 0, sentence: 12 }, to: { page: 0, sentence: 23 } })).toBe(
      '[PAGE 0] lines 12–23',
    );
    expect(describeBand({ from: { page: 0, sentence: 4 }, to: { page: 0, sentence: 4 } })).toBe('[PAGE 0] line 4');
    expect(describeBand({ from: { page: 1, sentence: 30 }, to: { page: 2, sentence: 3 } })).toBe(
      '[PAGE 1] line 30 to [PAGE 2] line 3',
    );
  });
});

describe('fillQuotas', () => {
  const bands = [0, 1, 2].map((i) => ({
    from: { page: 0, sentence: i * 10 },
    to: { page: 0, sentence: i * 10 + 9 },
    quota: 2,
  }));

  it('sends new cards to the parts with fewest so far', () => {
    expect(fillQuotas(bands, [2, 0, 0], 4).map((b) => b.quota)).toEqual([0, 2, 2]);
  });

  it('spreads evenly when every part has its share', () => {
    expect(fillQuotas(bands, [2, 2, 2], 3).map((b) => b.quota)).toEqual([1, 1, 1]);
  });

  it('always asks for exactly n', () => {
    expect(fillQuotas(bands, [5, 0, 1], 7).reduce((s, b) => s + b.quota, 0)).toBe(7);
  });
});

describe('locateExcerpt', () => {
  const page = 'Alpha line one\nBeta line two\nGamma line three\nDelta line four';

  it('finds the line a quote is', () => {
    expect(locateExcerpt(page, 'Gamma line three')).toBe(2);
  });

  it('finds where a widened quote starts', () => {
    expect(locateExcerpt(page, 'Beta line two Gamma line three Delta line four')).toBe(1);
  });

  it('does not match half a word', () => {
    expect(locateExcerpt('Beta\nBetamax tapes\nmore', 'Betamax tapes more')).toBe(1);
  });

  it('returns -1 for a quote from somewhere else', () => {
    expect(locateExcerpt(page, 'Omega')).toBe(-1);
  });
});

describe('lineKey and describeLines', () => {
  it('keys a line by page and number', () => {
    expect(lineKey({ page: 2, sentence: 14 })).toBe('2:14');
  });

  it('names lines one by one, page by page, in order', () => {
    expect(
      describeLines([
        { page: 1, sentence: 4 },
        { page: 0, sentence: 7 },
        { page: 0, sentence: 3 },
      ]),
    ).toBe('[PAGE 0] lines 3, 7; [PAGE 1] line 4');
  });
});

describe('shortfallBySection', () => {
  const sections = [
    { id: 'a', total: 10 },
    { id: 'b', total: 10 },
  ];

  it('owes the cards to the section that is short', () => {
    const out = shortfallBySection(sections, new Map([['a', 10], ['b', 2]]), 8);
    expect(Object.fromEntries(out)).toEqual({ a: 0, b: 8 });
  });

  it('follows the plan when no section is below its share', () => {
    const out = shortfallBySection(sections, new Map([['a', 10], ['b', 10]]), 2);
    expect(Object.fromEntries(out)).toEqual({ a: 1, b: 1 });
  });
});
