import { describe, expect, it } from 'vitest';
import {
  CELEBRATE_FROM,
  FINISH_LINES,
  finishBand,
  finishLine,
  finishReaction,
  RETURN_REACTION_MS,
  returnReaction,
} from '../src/core/celebrate';

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

});

describe('what Nomi says when a round ends (NOTES §45)', () => {
  it('follows how the round went, in six bands that agree with the reaction', () => {
    expect(finishBand(10, 10)).toBe('perfect');
    expect(finishBand(6, 7)).toBe('great');
    expect(finishBand(7, 10)).toBe('good');
    expect(finishBand(5, 10)).toBe('halfway');
    expect(finishBand(4, 10)).toBe('tough');
    expect(finishBand(1, 10)).toBe('tough');
    expect(finishBand(0, 10)).toBe('none');
    expect(finishBand(0, 0)).toBeNull();
    for (let right = 0; right <= 20; right++) {
      const celebrates = ['perfect', 'great', 'good'].includes(finishBand(right, 20)!);
      expect(celebrates, `${right} of 20`).toBe(finishReaction(right, 20) === 'success');
    }
  });

  it('has several things to say for each, with no numbers and nothing only a flashcard round could mean', () => {
    for (const [band, lines] of Object.entries(FINISH_LINES)) {
      expect(lines.length, band).toBeGreaterThanOrEqual(4);
      expect(new Set(lines).size, band).toBe(lines.length);
      for (const line of lines) {
        // The score is shown beside it; the quiz and the blanks use these too.
        expect(line, band).not.toMatch(/\d/);
        expect(line, band).not.toMatch(/\b(cards?|decks?|questions?|blanks?|model|token|API|prompt)\b/i);
      }
    }
  });

  it('still cheers below half — what the owner asked for', () => {
    for (const band of ['tough', 'none'] as const) {
      for (const line of FINISH_LINES[band]) {
        expect(line).toMatch(/!/);
        expect(line).not.toMatch(/\b(bad|badly|fail|failed|failing|poor|poorly|wrong|only|sadly|unfortunately|disappointing)\b/i);
      }
    }
  });

  it('picks from the right band, and never says the same thing twice running', () => {
    for (let r = 0; r < 1; r += 0.05) {
      const first = finishLine(3, 10, () => r)!;
      const next = finishLine(3, 10, () => r, first)!;
      expect(FINISH_LINES.tough).toContain(first);
      expect(FINISH_LINES.tough).toContain(next);
      expect(next).not.toBe(first);
    }
    expect(FINISH_LINES.perfect).toContain(finishLine(10, 10, () => 0.99));
    expect(finishLine(0, 0, () => 0)).toBeNull();
  });
});
