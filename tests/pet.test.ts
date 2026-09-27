import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PET,
  daysToNextStage,
  PET_SPECIES,
  PET_THRESHOLDS,
  petStage,
  toPetSpecies,
} from '../src/core/pet';

describe('choosing a pet', () => {
  it('offers the pets there is art for', () => {
    // Each name here needs assets/<name>-1.webp … -5.webp, cut by
    // scripts/make-pet-assets.ts, AND a matching entry in 0011's check
    // constraint as widened by 0014. Adding a name without the art is a blank
    // space where the pet should be; adding one without the constraint is a
    // save that fails.
    expect([...PET_SPECIES]).toEqual(['potato', 'cat', 'dog']);
  });

  it('falls back to the default rather than leaving no pet', () => {
    // NULL is the ordinary case — it means nobody has chosen yet. The rest are
    // values that should be impossible once 0011's check constraint is on, and
    // must still not leave the screen with nothing to draw.
    expect(toPetSpecies(null)).toBe(DEFAULT_PET);
    expect(toPetSpecies(undefined)).toBe(DEFAULT_PET);
    expect(toPetSpecies('')).toBe(DEFAULT_PET);
    expect(toPetSpecies('dinosaur')).toBe(DEFAULT_PET);
    expect(toPetSpecies(7)).toBe(DEFAULT_PET);
  });

  it('keeps a real choice', () => {
    expect(toPetSpecies('cat')).toBe('cat');
    expect(toPetSpecies('potato')).toBe('potato');
  });

  it('has a default that is one of the offered pets', () => {
    expect(PET_SPECIES).toContain(DEFAULT_PET);
  });
});

describe('petStage', () => {
  it('has no pet before the first day', () => {
    // Zero is not a tiny pet — it is no pet, and the screen says something
    // different for it.
    expect(petStage(0)).toBeNull();
    expect(petStage(-3)).toBeNull();
  });

  it('hatches on day one', () => {
    const s = petStage(1);
    expect(s?.name).toBe('baby');
    expect(s?.index).toBe(0);
  });

  it('grows at exactly the thresholds the owner asked for', () => {
    // 1, 2, 5, 10, 30 (NOTES §51) — "easier to build", replacing 1, 10, 20,
    // 50, 100. The baby still hatches on day one.
    expect(PET_THRESHOLDS.map((s) => s.at)).toEqual([1, 2, 5, 10, 30]);
    expect(petStage(1)?.name).toBe('baby');
    expect(petStage(2)?.name).toBe('small');
    expect(petStage(4)?.name).toBe('small');
    expect(petStage(5)?.name).toBe('medium');
    expect(petStage(9)?.name).toBe('medium');
    expect(petStage(10)?.name).toBe('large');
    expect(petStage(29)?.name).toBe('large');
    expect(petStage(30)?.name).toBe('giant');
  });

  it('stays at the top rather than running out of stages', () => {
    // A streak of a year must not index past the artwork — and 100 and 200,
    // which the owner listed, are past the last stage there is art for.
    for (const streak of [30, 100, 200, 365]) {
      const s = petStage(streak);
      expect(s?.name).toBe('giant');
      expect(s?.index).toBe(PET_THRESHOLDS.length - 1);
      expect(s?.nextAt).toBeNull();
      expect(s?.progress).toBe(1);
    }
  });

  it('measures progress across the current band, not the whole scale', () => {
    // Day 12 is 2 of the 20 days between 10 and 30 — one tenth. Measured
    // against the whole scale it would read as more than a third, and would
    // then barely move for weeks.
    expect(petStage(12)?.progress).toBeCloseTo(0.1);
    expect(petStage(20)?.progress).toBeCloseTo(0.5);
    expect(petStage(3)?.progress).toBeCloseTo(1 / 3);
  });

  it('never returns a stage the artwork does not have', () => {
    for (const streak of [1, 2, 5, 10, 33, 99, 100, 1000]) {
      const s = petStage(streak);
      expect(s).not.toBeNull();
      expect(s!.index).toBeGreaterThanOrEqual(0);
      expect(s!.index).toBeLessThan(PET_THRESHOLDS.length);
    }
  });
});

describe('daysToNextStage', () => {
  it('counts down to the next size', () => {
    expect(daysToNextStage(1)).toBe(1);
    expect(daysToNextStage(2)).toBe(3);
    expect(daysToNextStage(4)).toBe(1);
    expect(daysToNextStage(5)).toBe(5);
    expect(daysToNextStage(10)).toBe(20);
    expect(daysToNextStage(29)).toBe(1);
  });

  it('says nothing once the pet is fully grown', () => {
    expect(daysToNextStage(30)).toBeNull();
    expect(daysToNextStage(100)).toBeNull();
    expect(daysToNextStage(500)).toBeNull();
  });

  it('has nothing to count for someone with no streak', () => {
    expect(daysToNextStage(0)).toBeNull();
  });
});
