import { describe, expect, it } from 'vitest';
import { EXCERPT_MATCH_THRESHOLD, excerptMatches } from '../src/core/excerpt';
import { diceCoefficient, jaccard, normalize, wordCount } from '../src/core/text';

const PAGE = `The cardiac conduction system begins at the sinoatrial node, which sits in
the right atrium. The SA node fires roughly 60-100 times per minute and is called
the natural pacemaker of the heart. Impulses then travel to the atrioventricular
node, where conduction slows briefly to allow the ventricles to fill.`;

describe('normalize', () => {
  it('collapses whitespace, lowercases, and straightens quotes and dashes', () => {
    expect(normalize('  The   SA  node\n\tfires ')).toBe('the sa node fires');
    expect(normalize('“natural pacemaker’s”')).toBe('"natural pacemaker\'s"');
    expect(normalize('60–100')).toBe('60-100');
  });

  it('keeps punctuation, so a question is not equal to a statement', () => {
    expect(normalize('Cells divide?')).not.toBe(normalize('Cells divide'));
  });
});

describe('excerptMatches — exact tier', () => {
  it('matches a verbatim quote with score 1', () => {
    const r = excerptMatches('the natural pacemaker of the heart', PAGE);
    expect(r.matched).toBe(true);
    expect(r.score).toBe(1);
  });

  it('matches despite reflowed whitespace, which models always do', () => {
    const r = excerptMatches('the   atrioventricular\n\n  node', PAGE);
    expect(r.matched).toBe(true);
    expect(r.score).toBe(1);
  });

  it('matches despite curly quotes and en-dashes', () => {
    const r = excerptMatches('fires roughly 60–100 times per minute', PAGE);
    expect(r.matched).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(excerptMatches('THE SA NODE FIRES', PAGE).matched).toBe(true);
  });

  it('returns a span pointing into the ORIGINAL text for highlighting', () => {
    const r = excerptMatches('sinoatrial node', PAGE);
    expect(r.matched).toBe(true);
    expect(r.span).toBeDefined();
    expect(PAGE.slice(r.span!.start, r.span!.end).toLowerCase()).toContain('sinoatrial');
  });
});

describe('excerptMatches — fuzzy tier', () => {
  it('accepts a near-miss at or above the threshold', () => {
    // One word dropped from a long quote: still plainly the same sentence.
    const r = excerptMatches(
      'Impulses then travel to the atrioventricular node, where conduction slows to allow the ventricles to fill.',
      PAGE,
    );
    expect(r.score).toBeGreaterThanOrEqual(EXCERPT_MATCH_THRESHOLD);
    expect(r.matched).toBe(true);
  });

  it('REJECTS a plausible-sounding sentence that is not in the notes', () => {
    // The failure the whole validator exists to catch: fluent, on-topic, invented.
    const r = excerptMatches(
      'The bundle of His then carries the impulse into the left and right bundle branches.',
      PAGE,
    );
    expect(r.matched).toBe(false);
    expect(r.score).toBeLessThan(EXCERPT_MATCH_THRESHOLD);
  });

  it('rejects unrelated text outright', () => {
    expect(excerptMatches('Photosynthesis occurs in the chloroplast.', PAGE).matched).toBe(false);
  });

  it('handles empty input without throwing', () => {
    expect(excerptMatches('', PAGE).matched).toBe(false);
    expect(excerptMatches('anything', '').matched).toBe(false);
  });

  it('handles an excerpt longer than the page', () => {
    const r = excerptMatches(PAGE + ' plus a great deal of additional invented material.', 'short');
    expect(r.matched).toBe(false);
  });
});

describe('similarity primitives', () => {
  it('dice is 1 for identical and 0 for disjoint', () => {
    expect(diceCoefficient('abcdef', 'abcdef')).toBe(1);
    expect(diceCoefficient('aaaa', 'bbbb')).toBe(0);
  });

  it('jaccard ignores order and duplication', () => {
    expect(jaccard('the sa node fires', 'fires node the sa')).toBe(1);
  });

  it('wordCount ignores punctuation', () => {
    expect(wordCount('The SA node fires, roughly!')).toBe(5);
  });
});
