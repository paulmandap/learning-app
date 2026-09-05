import { describe, expect, it } from 'vitest';
import { rubricVerdict, shouldVerifyRubric } from '../src/core/rubric';

const CONCEPTS = [
  { id: 'c1', text: 'Water moves up through the xylem' },
  { id: 'c2', text: 'Sugars move through the phloem' },
  { id: 'c3', text: 'The two tissues run alongside each other' },
];

const APPLY_ITEM = {
  kind: 'short_answer',
  level: 'apply',
  rubric: { expected_concepts: CONCEPTS },
  rubricVerified: null as boolean | null,
};

describe('shouldVerifyRubric — D7 says Apply-tier rubrics only', () => {
  it('takes an unchecked Apply-tier written answer', () => {
    expect(shouldVerifyRubric(APPLY_ITEM)).toBe(true);
  });

  it('skips other levels', () => {
    for (const level of ['remember', 'understand']) {
      expect(shouldVerifyRubric({ ...APPLY_ITEM, level })).toBe(false);
    }
  });

  it('skips other kinds — only short answers are marked against a rubric', () => {
    for (const kind of ['flashcard', 'mcq']) {
      expect(shouldVerifyRubric({ ...APPLY_ITEM, kind })).toBe(false);
    }
  });

  it('skips an item with no rubric to check', () => {
    expect(shouldVerifyRubric({ ...APPLY_ITEM, rubric: null })).toBe(false);
    expect(shouldVerifyRubric({ ...APPLY_ITEM, rubric: { expected_concepts: [] } })).toBe(false);
  });

  it('never re-checks a card already checked, either way', () => {
    // Paying for the same second opinion on every visit to a set would be a
    // quota leak that grows with use.
    expect(shouldVerifyRubric({ ...APPLY_ITEM, rubricVerified: true })).toBe(false);
    expect(shouldVerifyRubric({ ...APPLY_ITEM, rubricVerified: false })).toBe(false);
  });
});

describe('rubricVerdict — the model names, the code decides', () => {
  it('verifies a rubric with nothing flagged', () => {
    const v = rubricVerdict(CONCEPTS, { unsupported: [], note: '' });
    expect(v).toEqual({ verified: true, unsupported: [], note: '' });
  });

  it('fails a rubric with one unsupported point', () => {
    const v = rubricVerdict(CONCEPTS, {
      unsupported: ['c3'],
      note: 'The notes never say the tissues run alongside each other.',
    });
    expect(v.verified).toBe(false);
    expect(v.unsupported).toEqual(['c3']);
  });

  it('discards ids the model invented', () => {
    // Same defence gradeWritten has: a model echoing plausible ids would
    // otherwise condemn every rubric it was shown.
    const v = rubricVerdict(CONCEPTS, { unsupported: ['c9', 'nonsense'], note: 'x' });
    expect(v.verified).toBe(true);
    expect(v.unsupported).toEqual([]);
  });

  it('de-duplicates repeated ids', () => {
    const v = rubricVerdict(CONCEPTS, { unsupported: ['c1', 'c1', 'c1'], note: '' });
    expect(v.unsupported).toEqual(['c1']);
  });

  it('treats "everything is wrong" as inconclusive, not as condemnation', () => {
    // A model flagging every point has misread the task far more often than a
    // generator has produced a wholly baseless checklist.
    const v = rubricVerdict(CONCEPTS, { unsupported: ['c1', 'c2', 'c3'], note: 'all bad' });
    expect(v.verified).toBe(true);
    expect(v.unsupported).toEqual([]);
    expect(v.note).toBe('');
  });

  it('keeps the note to one sentence, because it goes on screen', () => {
    const v = rubricVerdict(CONCEPTS, {
      unsupported: ['c2'],
      note: '  The source says nothing about sugars.   It only covers water. And more. ',
    });
    expect(v.note).toBe('The source says nothing about sugars.');
  });

  it('handles a note with no sentence punctuation', () => {
    const v = rubricVerdict(CONCEPTS, { unsupported: ['c2'], note: 'not in the notes' });
    expect(v.note).toBe('not in the notes');
  });

  it('is deterministic', () => {
    const reply = { unsupported: ['c2'], note: 'Not supported.' };
    expect(rubricVerdict(CONCEPTS, reply)).toEqual(rubricVerdict(CONCEPTS, reply));
  });

  it('verifies an empty rubric rather than dividing by zero', () => {
    expect(rubricVerdict([], { unsupported: [], note: '' }).verified).toBe(true);
  });
});
