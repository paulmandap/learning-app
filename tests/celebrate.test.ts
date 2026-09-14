import { describe, expect, it } from 'vitest';
import { CELEBRATE_FROM, finishLine, finishReaction } from '../src/core/celebrate';

describe('how Nomi reacts when a round ends (NOTES §43)', () => {
  it('celebrates seven in ten or better, and encourages below it', () => {
    expect(CELEBRATE_FROM).toBe(0.7);
    expect(finishReaction(7, 10)).toBe('success');
    expect(finishReaction(10, 10)).toBe('success');
    expect(finishReaction(6, 10)).toBe('encouraging');
    expect(finishReaction(0, 5)).toBe('encouraging');
  });

  it('says nothing about a round with nothing answered', () => {
    expect(finishReaction(0, 0)).toBeNull();
    expect(finishReaction(3, Number.NaN)).toBeNull();
  });

  it('has a line for each, with no jargon and no score repeated', () => {
    for (const [right, total] of [[10, 10], [8, 10], [3, 10], [0, 10]] as const) {
      const reaction = finishReaction(right, total)!;
      const line = finishLine(reaction, right, total);
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toMatch(/\d/);
    }
  });
});
