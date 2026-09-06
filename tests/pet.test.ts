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
    expect(petStage(9)?.name).toBe('baby');
    expect(petStage(10)?.name).toBe('small');
    expect(petStage(19)?.name).toBe('small');
    expect(petStage(20)?.name).toBe('medium');
    expect(petStage(49)?.name).toBe('medium');
    expect(petStage(50)?.name).toBe('large');
    expect(petStage(99)?.name).toBe('large');
    expect(petStage(100)?.name).toBe('giant');
  });

  it('stays at the top rather than running out of stages', () => {
    // A streak of a year must not index past the artwork.
    const s = petStage(365);
    expect(s?.name).toBe('giant');
    expect(s?.index).toBe(PET_THRESHOLDS.length - 1);
    expect(s?.nextAt).toBeNull();
    expect(s?.progress).toBe(1);
  });

  it('measures progress across the current band, not the whole scale', () => {
    // Day 55 is 5 of the 50 days between 50 and 100 — one tenth. Measured
    // against the whole scale it would read as more than half, and would then
    // barely move for weeks.
    expect(petStage(55)?.progress).toBeCloseTo(0.1);
    expect(petStage(15)?.progress).toBeCloseTo(0.5);
  });

  it('never returns a stage the artwork does not have', () => {
    for (const streak of [1, 5, 10, 33, 99, 100, 1000]) {
      const s = petStage(streak);
      expect(s).not.toBeNull();
      expect(s!.index).toBeGreaterThanOrEqual(0);
      expect(s!.index).toBeLessThan(PET_THRESHOLDS.length);
    }
  });
});

describe('daysToNextStage', () => {
  it('counts down to the next size', () => {
    expect(daysToNextStage(1)).toBe(9);
    expect(daysToNextStage(9)).toBe(1);
    expect(daysToNextStage(19)).toBe(1);
    expect(daysToNextStage(20)).toBe(30);
  });

  it('says nothing once the pet is fully grown', () => {
    expect(daysToNextStage(100)).toBeNull();
    expect(daysToNextStage(500)).toBeNull();
  });

  it('has nothing to count for someone with no streak', () => {
    expect(daysToNextStage(0)).toBeNull();
  });
});
