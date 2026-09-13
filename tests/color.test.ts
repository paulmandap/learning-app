import { describe, expect, it } from 'vitest';
import {
  contrast,
  contrastHex,
  deltaE2000,
  deltaEHex,
  luminance,
  parseHex,
  simulateCvd,
  toHex,
  toLab,
} from '../src/core/color';

/**
 * Anchored against PUBLISHED values, not against itself.
 *
 * A validator that only agrees with its own output is the failure it exists to
 * catch — §14.1 shipped an invisible chart segment because "these look fine"
 * was the whole check. Every number below is one that can be looked up:
 * white-on-black is exactly 21:1, Lab white is (100, 0, 0), and #767676 on
 * white is the canonical borderline-AA grey at ~4.54:1.
 */

describe('parseHex / toHex', () => {
  it('round-trips', () => {
    expect(toHex(parseHex('#0b3c49'))).toBe('#0b3c49');
  });

  it('expands three-digit hex', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('throws rather than guessing at nonsense', () => {
    expect(() => parseHex('teal')).toThrow(/not a hex colour/);
    expect(() => parseHex('#12345')).toThrow();
  });
});

describe('luminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(luminance(parseHex('#000000'))).toBeCloseTo(0, 6);
    expect(luminance(parseHex('#ffffff'))).toBeCloseTo(1, 6);
  });

  it('applies the sRGB gamma curve, not a linear divide', () => {
    // Mid grey is ~0.2159 relative luminance, NOT 0.5. Getting this wrong is
    // the classic error and would quietly shift every contrast figure.
    expect(luminance(parseHex('#808080'))).toBeCloseTo(0.2159, 3);
  });
});

describe('contrast', () => {
  it('is exactly 21:1 for black on white', () => {
    expect(contrastHex('#ffffff', '#000000')).toBeCloseTo(21, 5);
  });

  it('is exactly 1:1 for a colour against itself', () => {
    expect(contrastHex('#0b3c49', '#0b3c49')).toBeCloseTo(1, 10);
  });

  it('matches the canonical borderline-AA grey', () => {
    // #767676 on white is the standard example of "just passes 4.5:1".
    expect(contrastHex('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
  });

  it('does not depend on argument order', () => {
    const a = contrastHex('#0b3c49', '#eadcc8');
    const b = contrastHex('#eadcc8', '#0b3c49');
    expect(a).toBeCloseTo(b, 10);
  });

  it('reproduces the failure §14.1 recorded', () => {
    // The light border on the light card: 1.27:1, a segment nobody could see.
    // If this validator cannot reproduce the bug that motivated it, it is not
    // measuring the same thing.
    expect(contrastHex('#dfe1e6', '#ffffff')).toBeCloseTo(1.27, 1);
  });
});

describe('toLab', () => {
  it('puts white at (100, 0, 0)', () => {
    const [l, a, b] = toLab(parseHex('#ffffff'));
    expect(l).toBeCloseTo(100, 2);
    expect(a).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
  });

  it('puts black at L=0', () => {
    expect(toLab(parseHex('#000000'))[0]).toBeCloseTo(0, 4);
  });
});

describe('deltaE2000', () => {
  it('is 0 for identical colours', () => {
    expect(deltaEHex('#3d8b63', '#3d8b63')).toBeCloseTo(0, 10);
  });

  it('is symmetric', () => {
    expect(deltaEHex('#0b3c49', '#e5a134')).toBeCloseTo(deltaEHex('#e5a134', '#0b3c49'), 10);
  });

  it('is ~100 for black against white', () => {
    expect(deltaEHex('#000000', '#ffffff')).toBeGreaterThan(95);
    expect(deltaEHex('#000000', '#ffffff')).toBeLessThan(101);
  });

  it('does not overstate blue differences the way Euclidean Lab does', () => {
    // Two close blues. Plain Lab distance exaggerates these badly, which is
    // the whole reason for CIEDE2000 on a palette built around a teal.
    const euclid = (() => {
      const [l1, a1, b1] = toLab(parseHex('#0b3c49'));
      const [l2, a2, b2] = toLab(parseHex('#12455a'));
      return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
    })();
    expect(deltaEHex('#0b3c49', '#12455a')).toBeLessThan(euclid);
  });
});

describe('simulateCvd', () => {
  it('leaves greys alone', () => {
    // A neutral has no red/green information to lose, so both simulations
    // must return it essentially unchanged. If this drifts, the transform is
    // being applied in the wrong colour space.
    for (const kind of ['deuteranopia', 'protanopia'] as const) {
      const out = simulateCvd(parseHex('#808080'), kind);
      expect(out.r).toBeCloseTo(128, -1);
      expect(out.g).toBeCloseTo(128, -1);
      expect(out.b).toBeCloseTo(128, -1);
    }
  });

  it('collapses red and green toward each other', () => {
    // The defining property. Under normal vision red and green are far apart;
    // under deuteranopia they converge, and a palette that relies on that
    // distinction fails for real people.
    const normal = deltaEHex('#d0021b', '#3d8b63');
    const deut = deltaEHex('#d0021b', '#3d8b63', 'deuteranopia');
    expect(deut).toBeLessThan(normal / 2);
  });

  it('keeps a light/dark difference visible, because lightness survives', () => {
    // CVD removes hue channels, not luminance. A validator that made
    // everything identical would pass nothing and be useless.
    expect(deltaEHex('#ffffff', '#000000', 'protanopia')).toBeGreaterThan(90);
  });
});
