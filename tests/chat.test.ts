import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  conversationTitle,
  describeRemaining,
  describeWhen,
  historyWindow,
  HISTORY_WINDOW,
  isAskable,
  DAILY_MESSAGE_LIMIT,
  LOW_REMAINING,
  MAX_NOTES_CHARS,
  MAX_QUESTION_CHARS,
  MAX_REPLY_TOKENS,
  MAX_SAVED_CHARS,
  messageToKeep,
  trimNotes,
  type ChatTurn,
} from '../src/core/chat';
import { buildNomiSystemPrompt } from '../src/ai/prompts';

describe('what a conversation keeps, and what Gemini is told (NOTES §45)', () => {
  it('keeps a message whole, up to what the database takes, cut at a sentence past that', () => {
    const long = 'A sentence about cells. '.repeat(100).trim();
    expect(messageToKeep(long)).toBe(long);
    const huge = 'A sentence about cells. '.repeat(1000).trim();
    expect(messageToKeep(huge).length).toBeLessThanOrEqual(MAX_SAVED_CHARS);
    expect(messageToKeep(huge).endsWith('.')).toBe(true);
    const sql = readFileSync('supabase/migrations/0016_profile_pictures_and_nomi_chats.sql', 'utf8');
    expect(sql).toContain(`char_length(content) between 1 and ${MAX_SAVED_CHARS}`);
  });

  it('asks Gemini to say when a message is pasted notes, and says a message about their day never is', () => {
    const p = buildNomiSystemPrompt({ brief: '', context: { kind: 'none' } });
    expect(p).toContain('"pasted_notes"');
    expect(p).toMatch(/about their day[\s\S]*never pasted\s+notes/);
  });
});

describe('the budget', () => {
  it('keeps a worst-case day of Gemini replies under three study sets', () => {
    // Nomi became a chat at the owner's request (NOTES §36), which reverses
    // D14's one-question design, and the cap rose from 20 to 60. The principle
    // survives in a new number: generation is ~24k tokens a set, and a full
    // day of the longest possible replies must stay under three of those.
    // Nomi's own instant answers spend nothing and are not in this sum.
    expect(DAILY_MESSAGE_LIMIT * MAX_REPLY_TOKENS).toBeLessThan(3 * 24_000);
  });

  it('leaves room for the answer after the model has finished thinking', () => {
    // Measured on 2026-09-05: a realistic prompt spent 303-511 tokens thinking
    // before writing a word, and a 320 cap returned half a sentence or nothing
    // at all. The budget has to clear that with room for the reply.
    expect(MAX_REPLY_TOKENS).toBeGreaterThan(600);
  });

  it('bounds a single message and the history sent with it', () => {
    expect(MAX_NOTES_CHARS).toBeLessThanOrEqual(4000);
    expect(MAX_QUESTION_CHARS).toBeLessThanOrEqual(1000);
    expect(HISTORY_WINDOW).toBeLessThanOrEqual(20);
  });
});

describe('trimNotes', () => {
  it('leaves short notes alone', () => {
    expect(trimNotes('Xylem moves water upward.')).toBe('Xylem moves water upward.');
  });

  it('cuts on a sentence boundary rather than mid-word', () => {
    const notes = 'One sentence here. Two sentence here. Three sentence here.';
    const out = trimNotes(notes, 40);
    expect(out.endsWith('.')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
  });

  it('falls back to a hard cut when there is no boundary to find', () => {
    const wall = 'LEAF STEM ROOT FRUIT FLOWER '.repeat(50);
    const out = trimNotes(wall, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.length).toBeGreaterThan(50);
  });

  it('does not throw away most of the budget chasing a boundary', () => {
    const notes = 'Ok. ' + 'x'.repeat(200);
    expect(trimNotes(notes, 100).length).toBeGreaterThan(60);
  });

  it('trims surrounding whitespace', () => {
    expect(trimNotes('   spaced   ')).toBe('spaced');
  });
});

describe('isAskable', () => {
  it('accepts "Hi" — the owner could not send it at all', () => {
    // It demanded three characters. A greeting is answered by Nomi's own brain
    // now and spends nothing, so the floor had no reason left to exist.
    expect(isAskable('Hi')).toBe(true);
    expect(isAskable('?')).toBe(true);
  });

  it('rejects a blank box', () => {
    for (const q of ['', '   ', '\n\t']) expect(isAskable(q)).toBe(false);
  });

  it('rejects an essay', () => {
    expect(isAskable('x'.repeat(MAX_QUESTION_CHARS + 1))).toBe(false);
  });
});

describe('historyWindow', () => {
  const turns = (n: number): ChatTurn[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'nomi', text: `m${i}` }));

  it('keeps only the most recent turns', () => {
    const window = historyWindow(turns(50), 20);
    expect(window.length).toBeLessThanOrEqual(20);
    expect(window.at(-1)!.text).toBe('m49');
  });

  it('always opens on something the student said', () => {
    // An odd cut would start on a reply to a question the model cannot see.
    expect(historyWindow(turns(50), 19)[0]!.role).toBe('user');
    expect(historyWindow(turns(50), 20)[0]!.role).toBe('user');
  });

  it('keeps a short conversation whole', () => {
    expect(historyWindow(turns(3))).toHaveLength(3);
  });

  it('returns nothing when there is nothing the student said', () => {
    expect(historyWindow([{ role: 'nomi', text: 'hello' }])).toEqual([]);
  });
});

describe('conversationTitle', () => {
  it('uses a short first message as it is', () => {
    expect(conversationTitle('  what is my   streak  ')).toBe('what is my streak');
  });

  it('shortens a long one on a word, never mid-word', () => {
    const title = conversationTitle(
      'can you explain how the sinoatrial node controls the heart rate during exercise please',
    );
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });
});

describe('describeWhen', () => {
  const now = new Date(2026, 8, 13, 18, 0).getTime(); // local time, like the phone
  const hour = 60 * 60 * 1000;

  it('says a time for today, and Yesterday for yesterday', () => {
    expect(describeWhen(now - 2 * hour, now)).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
    expect(describeWhen(now - 24 * hour, now)).toBe('Yesterday');
  });

  it('names the weekday within the week, and the date before that', () => {
    expect(describeWhen(now - 3 * 24 * hour, now)).toMatch(/day$/);
    expect(describeWhen(now - 30 * 24 * hour, now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});

describe('describeRemaining', () => {
  it('says nothing while there is plenty left', () => {
    expect(describeRemaining(DAILY_MESSAGE_LIMIT)).toBeNull();
    expect(describeRemaining(LOW_REMAINING + 1)).toBeNull();
  });

  it('speaks up once it is nearly gone', () => {
    expect(describeRemaining(LOW_REMAINING)).toBe(`${LOW_REMAINING} more replies from me today.`);
    expect(describeRemaining(1)).toBe('1 more reply from me today.');
  });

  it('handles the last one and the one after, and says what still works', () => {
    expect(describeRemaining(0)).toMatch(/last reply/i);
    expect(describeRemaining(-1)).toMatch(/come back tomorrow/i);
    expect(describeRemaining(-1)).toMatch(/streak/i);
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

describe('buildNomiSystemPrompt', () => {
  const brief = 'FACTS ABOUT THE STUDENT, from the app, accurate right now:\n- Name: Paul';
  const card = {
    kind: 'card' as const,
    prompt: 'Which tissue carries water upward?',
    answer: 'Xylem',
    source: 'Xylem moves water upward from the roots.',
  };

  it('is Nomi, and welcomes everyday chat instead of refusing it', () => {
    // The owner said "Hi Nomi" and was told it could only help with study
    // notes. That rule is gone.
    const p = buildNomiSystemPrompt({ brief, context: { kind: 'none' } });
    expect(p).toMatch(/You are Nomi/);
    expect(p).toMatch(/small talk|everyday/i);
    expect(p).not.toMatch(/only help with/i);
  });

  it('knows who made it, and is honest that it uses Gemini (NOTES §49)', () => {
    const p = buildNomiSystemPrompt({ brief, context: { kind: 'none' } });
    expect(p).toContain('Paul Christian Mandap made you');
    expect(p).toMatch(/use Google's Gemini to help you\s+think/);
    expect(p).toMatch(/Never say you are ChatGPT, Gemini itself, or any other assistant/);
  });

  it('carries the facts about the student, and forbids inventing any', () => {
    const p = buildNomiSystemPrompt({ brief, context: { kind: 'none' } });
    expect(p).toContain('Name: Paul');
    expect(p).toMatch(/never guess/i);
  });

  it('puts the open card in front of the model, and keeps the notes-win rule', () => {
    const p = buildNomiSystemPrompt({ brief, context: card });
    expect(p).toContain('Which tissue carries water upward?');
    expect(p).toContain('Xylem moves water upward from the roots.');
    expect(p).toMatch(/examined on/i);
  });

  it('puts the set notes in when that is the context', () => {
    const p = buildNomiSystemPrompt({
      brief,
      context: { kind: 'set', title: 'Plant biology', notes: 'Roots absorb water.' },
    });
    expect(p).toContain('Plant biology');
    expect(p).toContain('Roots absorb water.');
  });

  it('asks for simple, direct, plain replies', () => {
    const p = buildNomiSystemPrompt({ brief, context: { kind: 'none' } });
    expect(p).toMatch(/simple and direct/i);
    expect(p).toMatch(/no headings|no bullet|no markdown/i);
  });

  it('says Nomi writes reviewers, and never to send them off to paste notes for one (NOTES §39)', () => {
    // Asked for a reviewer on computer parts, the owner was told twice to paste
    // notes — because this instruction said pasted notes were all the app took.
    const p = buildNomiSystemPrompt({ brief, context: { kind: 'none' } });
    expect(p).toContain('reviewer_topic');
    expect(p).toMatch(/Taglish/);
    expect(p).toMatch(/never tell them to paste/i);
    expect(p).not.toContain('set_title');
  });

  it('describes the offer waiting on a tap, and how to rename it', () => {
    const p = buildNomiSystemPrompt({
      brief,
      context: { kind: 'none' },
      pending: { kind: 'make_set', title: 'nomi gawan mo nga ako reviewer,', notes: 'n', count: 10, countPicked: true },
    });
    expect(p).toContain('Want me to make a new set, "nomi gawan mo nga ako reviewer,", with 10 cards?');
    expect(p).toContain('set_title');
  });
});
