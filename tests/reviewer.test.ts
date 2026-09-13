import { describe, expect, it, vi } from 'vitest';
import { checkReviewer, MIN_REVIEWER_FACTS, reviewerFacts, topicTitle } from '../src/core/reviewer';
import { MAX_PASTE_CHARS } from '../src/core/chat';
import { ReviewerUnusableError, writeReviewer } from '../src/data/reviewer';
import { parseChatResult, parseReviewerResult } from '../src/ai/schemas';

/**
 * A reviewer Nomi writes on a topic (NOTES §39): what is asked for, what it is
 * called, and the check that stands between what Gemini wrote and a set.
 */

/** A reviewer of `facts` one-line facts under one heading, 13 words each. */
function written(facts: number, bullet = '- '): string {
  const lines = ['# Parts inside the case'];
  for (let i = 0; i < facts; i++) lines.push(`${bullet}Part number ${i} of the computer does its own separate job inside the case.`);
  return lines.join('\n');
}

describe('reviewerFacts', () => {
  it('asks for half as many facts again as cards, between 15 and 90', () => {
    expect([10, 20, 40, 60, 100].map(reviewerFacts)).toEqual([15, 30, 60, 90, 90]);
  });
});

describe('topicTitle', () => {
  it('capitalises a topic typed in lower case, and keeps capitals the student typed', () => {
    expect(topicTitle('computer parts')).toBe('Computer Parts');
    expect(topicTitle('the solar system')).toBe('Solar System');
    expect(topicTitle('parts of a cell')).toBe('Parts of a Cell');
    expect(topicTitle('the French Revolution')).toBe('French Revolution');
    expect(topicTitle('DNA replication')).toBe('DNA replication');
    expect(topicTitle('  ')).toBe('My reviewer');
  });
});

describe('checkReviewer — the check behind the prompt', () => {
  it('counts the facts and how many cards they hold', () => {
    const checked = checkReviewer(written(30));
    expect(checked).toMatchObject({ ok: true, facts: 30 });
    expect(checked.ok && checked.supports).toBeGreaterThanOrEqual(20);
  });

  it('tidies what the prompt said not to write: a fence, bold, other bullets and heading levels', () => {
    const raw = ['```', '## **Parts**', written(10, '* ').split('\n').slice(1).join('\n'), '```'].join('\n');
    const checked = checkReviewer(raw);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.notes.startsWith('# Parts\n- Part number 0')).toBe(true);
    expect(checked.notes).not.toMatch(/```|\*\*|^\* /m);
  });

  it('takes a sentence without its bullet as a fact — the shape a real reviewer came back in', () => {
    // Measured 2026-09-14: asked for 30 facts, Gemini wrote 28 sentences under
    // seven headings, one per line, and not one "- ". It was turned away.
    const raw = written(12).replace(/^- /gm, '').replace('# Parts inside the case', 'Parts inside the case');
    const checked = checkReviewer(raw);
    expect(checked).toMatchObject({ ok: true, facts: 12 });
    if (!checked.ok) return;
    const [heading, first] = checked.notes.split('\n');
    expect(heading).toBe('Parts inside the case');
    expect(first).toBe('- Part number 0 of the computer does its own separate job inside the case.');
  });

  it('turns away a refusal, a one-liner, and nothing', () => {
    expect(checkReviewer("I'm sorry, I can't help with that topic.")).toEqual({ ok: false, reason: 'too_short' });
    expect(checkReviewer(written(MIN_REVIEWER_FACTS - 1))).toEqual({ ok: false, reason: 'too_short' });
    expect(checkReviewer('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('cuts anything past the largest paste Nomi takes, at a line', () => {
    const checked = checkReviewer(written(2000));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.notes.length).toBeLessThanOrEqual(MAX_PASTE_CHARS);
    expect(checked.notes.endsWith('inside the case.')).toBe(true);
  });
});

describe('writeReviewer', () => {
  const now = <T,>(task: () => Promise<T>) => task();

  it('asks for the facts the count needs, and returns the checked notes', async () => {
    const provider = { writeReviewer: vi.fn(async () => `**Intro**\n${written(30)}`) };
    const notes = await writeReviewer({ topic: 'computer parts', count: 20, apiKey: 'k' }, { provider, run: now });
    expect(provider.writeReviewer).toHaveBeenCalledWith({ topic: 'computer parts', facts: 30 });
    expect(notes).toContain('- Part number 29');
    expect(notes).not.toContain('**');
  });

  it('saves nothing it cannot use: a refusal throws before any note or set exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = { writeReviewer: vi.fn(async () => "I can't write about that.") };
    await expect(writeReviewer({ topic: 'x', count: 20, apiKey: 'k' }, { provider, run: now })).rejects.toBeInstanceOf(
      ReviewerUnusableError,
    );
    warn.mockRestore();
  });

  it('says so in the log when the notes hold fewer cards than were asked for', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = { writeReviewer: vi.fn(async () => written(12)) };
    await writeReviewer({ topic: 'computer parts', count: 60, apiKey: 'k' }, { provider, run: now });
    expect(warn.mock.calls.flat().join(' ')).toMatch(/60 were asked for/);
    warn.mockRestore();
  });
});

describe('what Gemini sends back', () => {
  it('a chat reply may name a topic or a title, and a blank one is none', () => {
    expect(parseChatResult({ answer: 'On it!', reviewer_topic: 'computer parts' })).toEqual({
      answer: 'On it!',
      reviewerTopic: 'computer parts',
      setTitle: null,
    });
    expect(parseChatResult({ answer: 'Hi!', set_title: '   ' })).toEqual({ answer: 'Hi!', reviewerTopic: null, setTitle: null });
    expect(parseChatResult({ answer: '', set_title: 'Bio 101' })).toMatchObject({ setTitle: 'Bio 101' });
    expect(parseChatResult({ answer: '' })).toBeNull();
    expect(parseChatResult('not json')).toBeNull();
  });

  it('a reviewer is its notes, or nothing', () => {
    expect(parseReviewerResult({ notes: '# A\n- b' })).toBe('# A\n- b');
    expect(parseReviewerResult({ notes: '  ' })).toBeNull();
    expect(parseReviewerResult({})).toBeNull();
  });
});
