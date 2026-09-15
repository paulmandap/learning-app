import { describe, expect, it } from 'vitest';
import { CELEBRATE_FROM, finishLine, finishReaction, RETURN_REACTION_MS, returnReaction } from '../src/core/celebrate';

describe('Nomi on Home reacts to a round just finished (NOTES §45)', () => {
  const at = Date.parse('2026-09-15T12:00:00Z');
  const round = { reaction: 'success' as const, at };

  it("plays the round's own reaction when Home comes back into view soon after", () => {
    expect(returnReaction(round, null, at + 5_000)).toBe('success');
    expect(returnReaction({ reaction: 'encouraging', at }, null, at + 5_000)).toBe('encouraging');
  });

  it('reacts once per round, and again to the next one', () => {
    expect(returnReaction(round, at + 5_000, at + 60_000)).toBeNull();
    expect(returnReaction({ ...round, at: at + 120_000 }, at + 5_000, at + 130_000)).toBe('success');
  });

  it('not to a round long over, or when there is none', () => {
    expect(returnReaction(round, null, at + RETURN_REACTION_MS + 1)).toBeNull();
    expect(returnReaction(null, null, at)).toBeNull();
  });
});

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
