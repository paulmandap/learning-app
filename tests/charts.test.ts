import { describe, expect, it } from 'vitest';
import { axisTicks, forecastShortLabel, niceAxisTop } from '../src/core/progress';

describe('the Progress columns (NOTES §37)', () => {
  it('labels a day with three letters, in UTC like the rest of the forecast', () => {
    // 2026-09-13 is a Sunday.
    expect(forecastShortLabel(Date.UTC(2026, 8, 13))).toBe('Sun');
    expect(forecastShortLabel(Date.UTC(2026, 8, 14))).toBe('Mon');
  });

  it('puts the top of the axis at a round number at or above the busiest day', () => {
    expect(niceAxisTop(1)).toBe(1);
    expect(niceAxisTop(3)).toBe(4);
    expect(niceAxisTop(4)).toBe(4);
    expect(niceAxisTop(8)).toBe(10);
    expect(niceAxisTop(12)).toBe(20);
    expect(niceAxisTop(45)).toBe(50);
    expect(niceAxisTop(100)).toBe(100);
  });

  it('still draws an axis for a week with nothing due', () => {
    expect(niceAxisTop(0)).toBe(4);
    expect(niceAxisTop(Number.NaN)).toBe(4);
  });

  it('keeps the numbers up the side few and whole', () => {
    expect(axisTicks(10)).toEqual([0, 5, 10]);
    expect(axisTicks(4)).toEqual([0, 2, 4]);
    expect(axisTicks(5)).toEqual([0, 5]);
    expect(axisTicks(1)).toEqual([0, 1]);
  });
});
