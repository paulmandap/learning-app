import { describe, expect, it } from 'vitest';
import { alignmentFor, CENTER_MAX_CHARS } from '../src/core/layout';

/**
 * The alignment rule from the UX review. These cases ARE the specification —
 * if the rule is retuned, the expectations here should be argued with first.
 */

describe('alignmentFor', () => {
  describe('centres short, focal content', () => {
    it('centres a single word', () => {
      expect(alignmentFor('Gorilla')).toBe('center');
      expect(alignmentFor('Axolotl')).toBe('center');
    });

    it('centres a term or acronym', () => {
      expect(alignmentFor('ATP')).toBe('center');
      expect(alignmentFor('Adenosine triphosphate')).toBe('center');
    });

    it('centres a short phrase', () => {
      expect(alignmentFor('The powerhouse of the cell')).toBe('center');
    });

    it('centres a standalone formula', () => {
      expect(alignmentFor('E = mc²')).toBe('center');
      expect(alignmentFor('F = ma')).toBe('center');
    });

    it('centres a short question, punctuation notwithstanding', () => {
      // A full sentence by the punctuation test, but one line on screen with no
      // next line to return to. Length is the property that matters here.
      expect(alignmentFor('What is ATP?')).toBe('center');
    });
  });

  describe('left-aligns anything the eye has to scan', () => {
    it('left-aligns a full-sentence definition', () => {
      expect(
        alignmentFor(
          'Adenosine triphosphate is the molecule cells use to store and transfer energy.',
        ),
      ).toBe('left');
    });

    it('left-aligns a multi-sentence explanation', () => {
      expect(
        alignmentFor(
          'Arctic terns migrate between the Arctic and the Antarctic each year. It is the ' +
            'longest known migration of any animal.',
        ),
      ).toBe('left');
    });

    it('left-aligns anything containing a line break, however short', () => {
      // Structure beats length: these really are multiple lines, and their
      // starts must align even though the text is tiny.
      expect(alignmentFor('Yes\nNo')).toBe('left');
    });

    it('left-aligns bulleted lists', () => {
      expect(alignmentFor('- one\n- two')).toBe('left');
      expect(alignmentFor('• alpha\n• beta')).toBe('left');
    });

    it('left-aligns numbered lists', () => {
      expect(alignmentFor('1. first\n2. second')).toBe('left');
      expect(alignmentFor('1) first\n2) second')).toBe('left');
    });
  });

  describe('the threshold itself', () => {
    it('centres at exactly the limit and left-aligns one character past it', () => {
      const atLimit = 'x'.repeat(CENTER_MAX_CHARS);
      const overLimit = 'x'.repeat(CENTER_MAX_CHARS + 1);
      expect(alignmentFor(atLimit)).toBe('center');
      expect(alignmentFor(overLimit)).toBe('left');
    });

    it('measures the trimmed text, so stray whitespace cannot flip it', () => {
      const padded = `   ${'x'.repeat(CENTER_MAX_CHARS)}   `;
      expect(alignmentFor(padded)).toBe('center');
    });

    it('accepts an override for a wider container', () => {
      const text = 'x'.repeat(50);
      expect(alignmentFor(text)).toBe('left');
      expect(alignmentFor(text, 60)).toBe('center');
    });
  });

  it('centres empty text rather than hugging the left edge', () => {
    expect(alignmentFor('')).toBe('center');
    expect(alignmentFor('   ')).toBe('center');
  });

  it('never returns anything but the two valid values', () => {
    const samples = ['', 'a', 'What is ATP?', 'x'.repeat(200), '- a\n- b', 'E = mc²'];
    for (const s of samples) {
      expect(['center', 'left']).toContain(alignmentFor(s));
    }
  });
});
