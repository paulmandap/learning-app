import { describe, expect, it } from 'vitest';
import {
  BLANK,
  gradeTypedAnswer,
  makeCloze,
  MAX_BLANK_WORDS,
  MIN_CONTEXT_WORDS,
  NEAR_MISS_THRESHOLD,
} from '../src/core/cloze';

/**
 * Real excerpts, taken from a live generation run over the plant-anatomy
 * fixture (2026-09-05). Using the shapes the generator actually produces
 * matters here: the ones that nearly work and the ones that cannot are both
 * things this module has to get right, and both were found by measurement
 * rather than imagined.
 */
const LEAF =
  'Its broad, flattened blade maximises the surface presented to light, while the internal ' +
  'mesophyll holds the chloroplasts where carbon fixation actually happens.';
const XYLEM =
  'Xylem moves water upward from the roots; phloem moves the sugars produced in the leaves ' +
  'to wherever they are needed or stored.';
const STOMATA = 'Gas exchange passes through stomata on the underside of the blade.';

function cloze(answer: string, sourceExcerpt: string, kind = 'flashcard') {
  return makeCloze({ kind, answer, sourceExcerpt });
}

describe('makeCloze — cutting the gap out of the notes', () => {
  it('blanks the answer where it sits in the sentence', () => {
    const r = cloze('Stomata.', STOMATA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cloze.text).toBe(`Gas exchange passes through ${BLANK} on the underside of the blade.`);
  });

  it('expects the notes’ spelling, not the model’s', () => {
    // The model wrote "Xylem." with a full stop; the notes wrote "Xylem".
    // The gap has to expect what the student actually read.
    const r = cloze('Xylem.', XYLEM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cloze.answer).toBe('Xylem');
    expect(r.cloze.text.startsWith(`${BLANK} moves water upward`)).toBe(true);
  });

  it('drops a leading article so "The mesophyll." finds "the internal mesophyll"', () => {
    // Measured: matching the article along with the term lost 2 of 6 otherwise
    // usable blanks, because the model writes "The X." and the notes qualify X.
    const r = cloze('The mesophyll.', LEAF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cloze.answer).toBe('mesophyll');
    expect(r.cloze.text).toContain(`the internal ${BLANK} holds`);
  });

  it('leaves the rest of the sentence byte-for-byte alone', () => {
    const r = cloze('Stomata.', STOMATA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cloze.text.split(BLANK).join(r.cloze.answer)).toBe(STOMATA);
    expect(r.cloze.source).toBe(STOMATA);
  });

  it('blanks every occurrence, so the sentence never shows its own answer', () => {
    const r = cloze('water', 'The water cycle moves water from the sea to the land.');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cloze.spans).toHaveLength(2);
    expect(r.cloze.text).not.toMatch(/water/i);
  });

  it('matches whole words only, so "ion" does not blank part of "region"', () => {
    const r = cloze('ion', 'The region below the collar is where absorption happens.');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('answer_not_in_notes');
  });
});

describe('makeCloze — what cannot become a blank', () => {
  it('takes flashcards only', () => {
    for (const kind of ['mcq', 'short_answer']) {
      const r = cloze('Stomata.', STOMATA, kind);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('not_flashcard');
    }
  });

  it(`refuses answers longer than ${MAX_BLANK_WORDS} words (D5's guard)`, () => {
    // A real generated answer. Grading four-plus words of free typing is the
    // frustration D5 postponed the feature over, so it is not attempted.
    const r = cloze(
      'Leaves, stem, flowers, and fruit.',
      'The shoot system sits above ground and carries the leaves, stem, flowers and fruit.',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('answer_too_long');
  });

  it('refuses when the answer is a paraphrase rather than words in the notes', () => {
    // "support & transport" in the notes, "Support and transport." from the
    // model. Nothing to cut out, so no card — rather than a wrong gap.
    const r = cloze('Support and transport.', 'support & transport');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('answer_not_in_notes');
  });

  it(`refuses when fewer than ${MIN_CONTEXT_WORDS} words would be left`, () => {
    const r = cloze('leaf', 'The leaf is green.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too_little_context');
  });

  it('refuses a transcribed label list, which is not a sentence', () => {
    // Straight from a diagram read. Four words, so it clears the context floor,
    // but "_____ seed dispersal structure STEM" is noise rather than a question.
    const r = cloze('The fruit.', 'FRUIT seed dispersal structure STEM');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_a_sentence');
  });

  it('keeps a terse definition line that still reads as one', () => {
    const r = cloze('mesophyll', 'The mesophyll is the tissue between the two leaf surfaces.');
    expect(r.ok).toBe(true);
  });
});

describe('gradeTypedAnswer — what is accepted outright', () => {
  it('ignores case, surrounding space and punctuation', () => {
    // The rule this module was specified with scored "ATP" vs "atp." at 0.800
    // and would have marked it wrong. Comparing words rather than raw
    // normalised text is what fixes it.
    for (const typed of ['ATP', 'atp', 'atp.', '  Atp ', 'ATP!']) {
      expect(gradeTypedAnswer(typed, 'ATP').verdict).toBe('correct');
    }
  });

  it('ignores a leading article, which cannot change which thing is meant', () => {
    expect(gradeTypedAnswer('the leaf', 'leaf').verdict).toBe('correct');
    expect(gradeTypedAnswer('leaf', 'the leaf').verdict).toBe('correct');
  });

  it('ignores hyphenation', () => {
    expect(gradeTypedAnswer('sino atrial node', 'sino-atrial node').verdict).toBe('correct');
  });

  it('treats a number spelled out as the same number', () => {
    // Reported from real use: the notes said "60 seconds and 7 days", the
    // student wrote it in words and was marked wrong.
    expect(gradeTypedAnswer('sixty seconds', '60 seconds').verdict).toBe('correct');
    expect(gradeTypedAnswer('60 seconds', 'sixty seconds').verdict).toBe('correct');
    expect(gradeTypedAnswer('seven days', '7 days').verdict).toBe('correct');
    expect(gradeTypedAnswer('twenty one', '21').verdict).toBe('correct');
    expect(gradeTypedAnswer('twenty-one', '21').verdict).toBe('correct');
    expect(gradeTypedAnswer('two thousand', '2000').verdict).toBe('correct');
    expect(gradeTypedAnswer('one hundred twenty', '120').verdict).toBe('correct');
  });

  it('does not weld separate quantities together', () => {
    // "and" ends a run, so "60 seconds and 7 days" stays two numbers rather
    // than becoming one.
    expect(gradeTypedAnswer('sixty seconds and seven days', '60 seconds and 7 days').verdict).toBe(
      'correct',
    );
    expect(gradeTypedAnswer('sixty seconds and seven days', '67 days').verdict).not.toBe('correct');
  });

  it('still tells different numbers apart', () => {
    expect(gradeTypedAnswer('seven days', '8 days').verdict).not.toBe('correct');
    expect(gradeTypedAnswer('sixty', '16').verdict).not.toBe('correct');
  });

  it('does not accept an empty answer for a non-empty one', () => {
    expect(gradeTypedAnswer('', 'xylem').verdict).toBe('incorrect');
    expect(gradeTypedAnswer('   ', 'xylem').verdict).toBe('incorrect');
  });
});

describe('gradeTypedAnswer — the near-miss band exists because no threshold works', () => {
  /**
   * The finding this whole design rests on, pinned as a test so it cannot be
   * quietly re-litigated: a one-character typo and a minimal-pair confusable
   * are the same distance apart, so any band that forgives typing also accepts
   * a genuinely different answer.
   */
  it('scores a real confusable ABOVE a real typo', () => {
    const confusable = gradeTypedAnswer('efferent', 'afferent').score;
    const typo = gradeTypedAnswer('photosynthasis', 'photosynthesis').score;
    expect(confusable).toBeGreaterThan(typo);
    // And both sit either side of the 0.85 the roadmap specified, which is
    // exactly the wrong way round.
    expect(confusable).toBeGreaterThan(0.85);
    expect(typo).toBeLessThan(0.85);
  });

  it('never marks a confusable correct — it asks instead', () => {
    for (const [typed, expected] of [
      ['efferent', 'afferent'],
      ['meiosis', 'mitosis'],
      ['arterioles', 'arteries'],
      ['intercellular', 'intracellular'],
      ['ribosome', 'ribose'],
    ] as const) {
      expect(gradeTypedAnswer(typed, expected).verdict).not.toBe('correct');
    }
  });

  it('offers the benefit of the doubt on single-character typos', () => {
    for (const [typed, expected] of [
      ['mitochondira', 'mitochondria'],
      ['mitochondrai', 'mitochondria'],
      ['ribsoome', 'ribosome'],
      ['chlorpolast', 'chloroplast'],
      ['stma', 'stoma'],
      ['photosynthasis', 'photosynthesis'],
    ] as const) {
      expect(gradeTypedAnswer(typed, expected).verdict).toBe('near');
    }
  });

  it('calls an unrelated answer wrong rather than near', () => {
    for (const [typed, expected] of [
      ['nucleus', 'chloroplast'],
      ['RNA', 'ATP'],
      ['the root', 'the leaf'],
      ['i do not know', 'mitochondria'],
    ] as const) {
      expect(gradeTypedAnswer(typed, expected).verdict).toBe('incorrect');
    }
  });

  it('puts the band boundary where the threshold says', () => {
    const near = gradeTypedAnswer('stma', 'stoma');
    expect(near.score).toBeGreaterThanOrEqual(NEAR_MISS_THRESHOLD);
    const wrong = gradeTypedAnswer('the root', 'the leaf');
    expect(wrong.score).toBeLessThan(NEAR_MISS_THRESHOLD);
  });

  it('is symmetric and deterministic', () => {
    const a = gradeTypedAnswer('ribsoome', 'ribosome');
    const b = gradeTypedAnswer('ribosome', 'ribsoome');
    expect(a.score).toBeCloseTo(b.score, 10);
    expect(gradeTypedAnswer('ribsoome', 'ribosome')).toEqual(a);
  });
});
