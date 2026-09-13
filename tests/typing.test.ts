import { describe, expect, it } from 'vitest';
import {
  CHAR_MS,
  MAX_TYPING_MS,
  PAUSE_MS,
  revealedCount,
  revealSchedule,
  THINK_MS,
  typingDuration,
} from '../src/core/typing';

describe("Nomi's typing (NOTES §37)", () => {
  it('thinks for about a second first, as the owner asked', () => {
    expect(THINK_MS).toBe(1000);
  });

  it('gives every character a time, never going backwards', () => {
    const schedule = revealSchedule('Hi there, Paul.');
    expect(schedule).toHaveLength('Hi there, Paul.'.length);
    for (let i = 1; i < schedule.length; i++) expect(schedule[i]!).toBeGreaterThanOrEqual(schedule[i - 1]!);
  });

  it('pauses after punctuation, like someone typing a sentence', () => {
    const plain = revealSchedule('ab');
    const comma = revealSchedule('a,b');
    expect(plain).toEqual([CHAR_MS, 2 * CHAR_MS]);
    expect(comma[2]! - comma[1]!).toBe(CHAR_MS + PAUSE_MS[',']!);
  });

  it('never takes longer than the cap, however long the line', () => {
    expect(typingDuration('x'.repeat(500))).toBeLessThanOrEqual(MAX_TYPING_MS);
    expect(typingDuration('16 cards due today. Want to start?')).toBeLessThanOrEqual(MAX_TYPING_MS);
  });

  it('reveals nothing before it starts and everything by the end', () => {
    const text = '1-day streak, and today counts.';
    const schedule = revealSchedule(text);
    expect(revealedCount(schedule, 0)).toBe(0);
    expect(revealedCount(schedule, typingDuration(text))).toBe(text.length);
    expect(revealedCount(schedule, 10_000)).toBe(text.length);
  });

  it('only ever reveals more as time passes', () => {
    const schedule = revealSchedule('Add some notes and I will help you study them.');
    let last = 0;
    for (let t = 0; t <= 2500; t += 37) {
      const n = revealedCount(schedule, t);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  });

  it('handles an empty line', () => {
    expect(revealSchedule('')).toEqual([]);
    expect(typingDuration('')).toBe(0);
  });
});
