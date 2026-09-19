import { describe, expect, it } from 'vitest';
import { ALL_EMOJI, appendEmoji, EMOJI_GROUPS, QUICK_EMOJI } from '../src/core/emoji';

/**
 * The chat's emoji shortcut (NOTES §47).
 *
 * A short list rather than a picker, so there is no library to keep in step —
 * which means the only things that can be wrong are the list itself and where
 * the spaces go.
 */

describe('the list', () => {
  it('is grouped, and every group has a plain-English name', () => {
    expect(EMOJI_GROUPS.length).toBeGreaterThan(2);
    for (const group of EMOJI_GROUPS) {
      expect(group.label).toMatch(/^[A-Z][a-z]+$/);
      expect(group.emoji.length).toBeGreaterThan(3);
    }
  });

  it('offers no emoji twice', () => {
    // Two rows offering 🔥 is two places to look for the same thing.
    expect(new Set(ALL_EMOJI).size).toBe(ALL_EMOJI.length);
  });

  it('keeps the quick row inside the full list', () => {
    for (const e of QUICK_EMOJI) expect(ALL_EMOJI).toContain(e);
  });

  it('stays small enough to read without searching', () => {
    // The moment this needs a search box it needs a library, and a library is a
    // download on every start. src/core/emoji.ts records that decision.
    expect(ALL_EMOJI.length).toBeLessThanOrEqual(64);
  });
});

describe('putting one into what you were typing', () => {
  it('starts a message with no leading space', () => {
    expect(appendEmoji('', '👍')).toBe('👍');
  });

  it('separates an emoji from a word', () => {
    expect(appendEmoji('nice', '👍')).toBe('nice 👍');
  });

  it('does not double a space that is already there', () => {
    expect(appendEmoji('nice ', '👍')).toBe('nice 👍');
  });

  it('runs emoji together, which is what tapping three in a row means', () => {
    // "😀😂🔥", not "😀 😂 🔥".
    const three = ['😀', '😂', '🔥'].reduce(appendEmoji, '');
    expect(three).toBe('😀😂🔥');
  });

  it('handles the ones made of more than one character', () => {
    // ❤️ and ✌️ carry a variation selector, so `endsWith` on the raw string is
    // what has to match, not a single code point.
    expect(appendEmoji('❤️', '❤️')).toBe('❤️❤️');
    expect(appendEmoji('yes', '✌️')).toBe('yes ✌️');
  });
});
