import { describe, expect, it } from 'vitest';
import {
  describeRemaining,
  isAskable,
  DAILY_MESSAGE_LIMIT,
  LOW_REMAINING,
  MAX_NOTES_CHARS,
  MAX_QUESTION_CHARS,
  MAX_REPLY_TOKENS,
  trimNotes,
} from '../src/core/chat';
import { buildChatPrompt } from '../src/ai/prompts';

describe('the budget', () => {
  it('keeps a full day of questions comparable to one study set', () => {
    // The comparison that matters: the assistant must never quietly become the
    // more expensive half of a shared free-tier allowance. Generation is
    // output-bound at roughly 2,000-4,000 tokens per section (§3.2.3), so a
    // set is ~24k. A full day of questions must stay under that.
    //
    // Worst case, not typical: MAX_REPLY_TOKENS budgets thinking AND answer
    // together, and measured usage was ~550 of it, not the whole allowance.
    expect(DAILY_MESSAGE_LIMIT * MAX_REPLY_TOKENS).toBeLessThan(24_000);
  });

  it('leaves room for the answer after the model has finished thinking', () => {
    // Measured on 2026-09-05: a realistic prompt spent 303-511 tokens thinking
    // before writing a word, and a 320 cap returned half a sentence or nothing
    // at all. The budget has to clear that with room for the reply.
    expect(MAX_REPLY_TOKENS).toBeGreaterThan(600);
  });

  it('bounds a single question', () => {
    expect(MAX_NOTES_CHARS).toBeLessThanOrEqual(4000);
    expect(MAX_QUESTION_CHARS).toBeLessThanOrEqual(500);
  });
});

describe('trimNotes', () => {
  it('leaves short notes alone', () => {
    expect(trimNotes('Xylem moves water upward.')).toBe('Xylem moves water upward.');
  });

  it('cuts on a sentence boundary rather than mid-word', () => {
    // Cutting mid-word leaves the model completing a fragment, which reads as
    // though the notes themselves are damaged.
    const notes = 'One sentence here. Two sentence here. Three sentence here.';
    const out = trimNotes(notes, 40);
    expect(out.endsWith('.')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
  });

  it('falls back to a hard cut when there is no boundary to find', () => {
    // A transcribed diagram can be one long line with no full stop in it.
    const wall = 'LEAF STEM ROOT FRUIT FLOWER '.repeat(50);
    const out = trimNotes(wall, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.length).toBeGreaterThan(50);
  });

  it('does not throw away most of the budget chasing a boundary', () => {
    // A full stop at character 5 must not shrink a 100-character budget to 5.
    const notes = 'Ok. ' + 'x'.repeat(200);
    expect(trimNotes(notes, 100).length).toBeGreaterThan(60);
  });

  it('trims surrounding whitespace', () => {
    expect(trimNotes('   spaced   ')).toBe('spaced');
  });
});

describe('isAskable', () => {
  it('accepts a real question', () => {
    expect(isAskable('Why is the leaf the photosynthetic organ?')).toBe(true);
  });

  it('rejects nothing and near-nothing', () => {
    // A cheap gate, so an empty box does not spend one of twenty questions.
    for (const q of ['', '   ', 'a', '?']) expect(isAskable(q)).toBe(false);
  });

  it('rejects an essay', () => {
    expect(isAskable('x'.repeat(MAX_QUESTION_CHARS + 1))).toBe(false);
  });
});

describe('describeRemaining', () => {
  it('says nothing while there is plenty left', () => {
    // The owner asked not to be told about limits every time. A counter through
    // nineteen unremarkable questions makes an allowance feel like a meter.
    expect(describeRemaining(DAILY_MESSAGE_LIMIT)).toBeNull();
    expect(describeRemaining(LOW_REMAINING + 1)).toBeNull();
  });

  it('speaks up once it is nearly gone', () => {
    expect(describeRemaining(LOW_REMAINING)).toBe(`${LOW_REMAINING} more questions today.`);
    expect(describeRemaining(1)).toBe('1 more question today.');
  });

  it('handles the last one and the one after', () => {
    expect(describeRemaining(0)).toMatch(/last question/i);
    expect(describeRemaining(-1)).toMatch(/come back tomorrow/i);
  });

  it('never uses jargon on a student screen', () => {
    for (const n of [-1, 0, 1, 3]) {
      const text = describeRemaining(n) ?? '';
      for (const word of ['quota', 'token', 'rate limit', 'API', 'request']) {
        expect(text.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });
});

describe('buildChatPrompt', () => {
  const card = {
    kind: 'card' as const,
    prompt: 'Which tissue carries water upward?',
    answer: 'Xylem',
    source: 'Xylem moves water upward from the roots.',
  };

  it('puts the open card in front of the model', () => {
    const p = buildChatPrompt({ question: 'Why?', context: card });
    expect(p).toContain('Which tissue carries water upward?');
    expect(p).toContain('Xylem moves water upward from the roots.');
    expect(p).toContain('Why?');
  });

  it('puts the set notes in when that is the context', () => {
    const p = buildChatPrompt({
      question: 'Summarise this',
      context: { kind: 'set', title: 'Plant biology', notes: 'Roots absorb water.' },
    });
    expect(p).toContain('Plant biology');
    expect(p).toContain('Roots absorb water.');
  });

  it('still asks something sensible with no context at all', () => {
    const p = buildChatPrompt({ question: 'What is xylem?', context: { kind: 'none' } });
    expect(p).toContain('What is xylem?');
    expect(p.length).toBeGreaterThan(50);
  });

  it("tells the model the student's notes win", () => {
    // The failure that matters is not a bad answer, it is a confident answer
    // contradicting the notes they are about to be examined on.
    const p = buildChatPrompt({ question: 'Why?', context: card });
    expect(p).toMatch(/examined on/i);
    expect(p).toMatch(/not in their notes/i);
  });

  it('asks for a short, plain answer', () => {
    const p = buildChatPrompt({ question: 'Why?', context: card });
    expect(p).toMatch(/four sentences/i);
    expect(p).toMatch(/no headings|no bullet/i);
  });
});
