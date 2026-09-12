import { describe, expect, it } from 'vitest';
import {
  MIN_TREND_WINDOW,
  sectionTrends,
  TREND_THRESHOLD,
  type AttemptRecord,
} from '../src/core/progress';

/**
 * sectionTrends — is a section getting better, or worse?
 *
 * ## Why half of this file is a simulation
 *
 * `app/(tabs)/progress.tsx` carries a standing decision against plotting
 * accuracy over time: *"with a handful of answers a day it would be mostly
 * noise, and a noisy chart of a real measure is worse than no chart."*
 *
 * A direction label is not a chart, but it answers to exactly that objection.
 * So the gate keeping it quiet is measured rather than asserted: the second
 * half of this file runs the rule against a student whose real accuracy never
 * moves, where every direction reported is a false alarm because there is
 * nothing to detect.
 *
 * That measurement killed the first attempt. Six answers per window with a
 * one-third threshold — which looked entirely reasonable — cried wolf **38.5%**
 * of the time. See `MIN_TREND_WINDOW` for the full table.
 *
 * The live data could not settle it: the test account holds 33 answers across
 * two days and two sections, and the owner's own account is OTP-only, so no
 * script can sign into the one history worth measuring.
 */

/** A fixed UTC noon, so nothing here depends on when the tests run. */
const NOON = Date.UTC(2026, 8, 5, 12, 0, 0);

/** One answer in `section`, `n` places along. Only the order matters. */
const at = (
  section: string | null,
  result: AttemptRecord['result'],
  n: number,
): AttemptRecord => ({ section, result, at: NOON + n });

/** A section's answers, oldest first, from a pattern. */
function run(section: string, pattern: AttemptRecord['result'][]): AttemptRecord[] {
  return pattern.map((r, i) => at(section, r, i));
}

const wrong = (n: number) => Array<AttemptRecord['result']>(n).fill('incorrect');
const right = (n: number) => Array<AttemptRecord['result']>(n).fill('correct');

/** One full window, so the tests read in terms of the gate rather than a number. */
const W = MIN_TREND_WINDOW;

describe('sectionTrends', () => {
  it('says nothing at all about a section with too little history', () => {
    // "We do not know yet" and "you are holding level" are different things,
    // and only one of them is worth a line on a screen. One short of two
    // full windows.
    expect(sectionTrends(run('Renal', right(W * 2 - 1)))).toEqual([]);
  });

  it('sees a section climbing out of trouble', () => {
    const [trend] = sectionTrends(run('Renal', [...wrong(W), ...right(W)]));
    expect(trend).toMatchObject({ section: 'Renal', direction: 'improving' });
    expect(trend!.earlier).toBe(0);
    expect(trend!.recent).toBe(1);
  });

  it('sees a section going backwards', () => {
    const [trend] = sectionTrends(run('Renal', [...right(W), ...wrong(W)]));
    expect(trend).toMatchObject({ direction: 'slipping', change: -1 });
  });

  it('calls an unchanged section steady rather than inventing a direction', () => {
    expect(sectionTrends(run('Renal', right(W * 2)))[0]).toMatchObject({
      direction: 'steady',
      change: 0,
    });
  });

  it('reads the order from the timestamps, not from the array', () => {
    // Rows arrive from PostgREST in whatever order the query returned them,
    // and the dashboard asks for newest first.
    const rows = run('Renal', [...wrong(W), ...right(W)]);
    expect(sectionTrends([...rows].reverse())[0]!.direction).toBe('improving');
  });

  it('keeps the two windows the same size', () => {
    // Splitting 11 answers 6/5 would compare windows with different noise
    // floors, and the bigger one would look steadier for no reason a student
    // could see. On an odd count the middle answer is dropped instead.
    const [trend] = sectionTrends(run('Renal', [...wrong(W), 'correct', ...right(W)]));
    expect(trend!.attempts).toBe(W * 2);
    expect(trend!.earlier).toBe(0);
    expect(trend!.recent).toBe(1);
  });

  it('ignores answers that belong to no section', () => {
    expect(sectionTrends(right(W * 2).map((r, i) => at(null, r, i)))).toEqual([]);
  });

  it('reports each section separately, biggest movement first', () => {
    const out = sectionTrends([
      ...run('Small', [...right(W), ...wrong(W / 2), ...right(W / 2)]),
      ...run('Big', [...wrong(W), ...right(W)]),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.section).toBe('Big');
  });

  it('is deterministic when two sections move the same amount', () => {
    const rows = [
      ...run('Zeta', [...wrong(W), ...right(W)]),
      ...run('Alpha', [...wrong(W), ...right(W)]),
    ];
    expect(sectionTrends(rows).map((t) => t.section)).toEqual(['Alpha', 'Zeta']);
  });

  it('drops partials instead of scoring them wrong, as sectionSplit does', () => {
    // Not a free choice. If the two disagreed, one screen would call a section
    // 43% and describe it as improving on a different definition of the number.
    //
    // Changed 2026-09-12 (§32). This test previously pinned the opposite: a
    // run of partials followed by correct answers read as 0 -> 1, improving.
    //
    // Dropping them is also what preserves the §26.1 calibration. The windows
    // stay sequences of purely right-or-wrong answers, which is what the
    // false-alarm rate was simulated over.
    const clean = [...wrong(W), ...right(W)];
    const peppered: AttemptRecord['result'][] = [
      ...wrong(W),
      'partial',
      'partial',
      'partial',
      ...right(W),
    ];

    const before = sectionTrends(run('Renal', clean))[0];
    const after = sectionTrends(run('Renal', peppered))[0];

    // Three partials dropped into the middle change nothing at all: not the
    // direction, not either window, not the size of the move.
    expect(after).toMatchObject({
      direction: before!.direction,
      earlier: before!.earlier,
      recent: before!.recent,
      change: before!.change,
    });
    expect(before!.direction).toBe('improving');
  });

  it('stays silent when partials leave too few real answers to judge', () => {
    // Twenty answers, but half of them partial: only ten are evidence, which
    // is five per window and under the gate. Reporting a direction off that
    // would be exactly the noise MIN_TREND_WINDOW exists to refuse.
    const half: AttemptRecord['result'][] = [];
    for (let i = 0; i < W; i++) half.push('partial', i < W / 2 ? 'incorrect' : 'correct');
    expect(sectionTrends(run('Renal', half))).toEqual([]);
  });

  it('will not call a move smaller than the threshold a direction', () => {
    // Three more right out of ten is 0.3, under the 0.4 it takes to speak.
    const [trend] = sectionTrends(run('Renal', [...wrong(3), ...right(W - 3), ...right(W)]));
    expect(Math.abs(trend!.change)).toBeLessThan(TREND_THRESHOLD);
    expect(trend!.direction).toBe('steady');
  });

  it('speaks exactly at the threshold, not just past it', () => {
    // Four more right out of ten. A boundary written as >= must behave like it.
    const [trend] = sectionTrends(run('Renal', [...wrong(4), ...right(W - 4), ...right(W)]));
    expect(trend!.change).toBeCloseTo(TREND_THRESHOLD, 10);
    expect(trend!.direction).toBe('improving');
  });
});

/**
 * The gate, measured.
 *
 * A student whose real accuracy never changes, run through the rule many times.
 * Every direction reported here is a false alarm. This is what separates "we
 * chose ten and four tenths" from "we measured what ten and four tenths buys".
 */
describe('how often sectionTrends cries wolf', () => {
  /** Deterministic PRNG, so the measured rate is identical on every run. */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  /** Share of trials claiming a direction for a student who never changed. */
  function falseAlarmRate(trueAccuracy: number, trials = 4000): number {
    const next = rng(20260912);
    let claimed = 0;
    for (let t = 0; t < trials; t++) {
      const rows: AttemptRecord[] = [];
      for (let i = 0; i < W * 2; i++) {
        rows.push(at('S', next() < trueAccuracy ? 'correct' : 'incorrect', i));
      }
      const [trend] = sectionTrends(rows);
      if (trend && trend.direction !== 'steady') claimed++;
    }
    return claimed / trials;
  }

  /** Share of trials catching a real shift from `p1` to `p2`. */
  function power(p1: number, p2: number, trials = 4000): number {
    const next = rng(777);
    let caught = 0;
    for (let t = 0; t < trials; t++) {
      const rows: AttemptRecord[] = [];
      for (let i = 0; i < W; i++) rows.push(at('S', next() < p1 ? 'correct' : 'incorrect', i));
      for (let i = 0; i < W; i++) rows.push(at('S', next() < p2 ? 'correct' : 'incorrect', W + i));
      const [trend] = sectionTrends(rows);
      if (trend && trend.direction !== 'steady') caught++;
    }
    return caught / trials;
  }

  it('stays quiet for a student whose accuracy is not moving', () => {
    // p = 0.5 is the hardest case: variance is greatest there. The rejected
    // six-per-window setting scored 0.385 on this exact measurement.
    const rate = falseAlarmRate(0.5);
    expect(rate, `false alarms at p=0.5, ${W} per window: ${rate}`).toBeLessThan(0.1);
  });

  it('is quieter still for a student who is consistently strong', () => {
    const rate = falseAlarmRate(0.85);
    expect(rate, `false alarms at p=0.85: ${rate}`).toBeLessThan(0.05);
  });

  it('still notices a real change when there is one', () => {
    // A gate that never fires is not caution, it is a broken feature. Half the
    // time on a genuine 0.4 -> 0.8 shift is the price of the quiet above.
    const caught = power(0.4, 0.8);
    expect(caught, `caught a real 0.4->0.8 shift ${caught} of the time`).toBeGreaterThan(0.4);
  });

  it('is far more likely to miss a real change than to invent one', () => {
    // The asymmetry that matters for a study companion: saying nothing is
    // recoverable, telling someone they are slipping when they are not is not.
    expect(power(0.4, 0.8)).toBeGreaterThan(falseAlarmRate(0.5) * 4);
  });
});
