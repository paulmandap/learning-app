/**
 * Colour maths, for validating a palette before it ships.
 *
 * ## Why this exists at all
 *
 * §14.1 records the last palette change failing in a way nobody saw: a chart
 * segment drawn with `border` measured **1.27:1** against the card and was
 * effectively invisible. It shipped because "these colours look fine" is not a
 * measurement.
 *
 * The teal/amber re-theme replaces 11 semantic roles across two modes plus a
 * five-colour chart palette, so it invalidates that validation entirely. This
 * is the instrument that redoes it, and `scripts/palette-check.ts` is the gate.
 *
 * ## Pure, and in src/core, so it can be tested
 *
 * No react-native import and no dependency: the maths is short and the whole
 * point is that it can be checked against known anchors — white on black is
 * exactly 21:1, a colour against itself is exactly 1:1, and Lab white is
 * (100, 0, 0). A validator nothing can test is the thing it is meant to catch.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rrggbb` (or `#rgb`) to 0-255 channels. Throws rather than guessing. */
export function parseHex(hex: string): Rgb {
  const s = hex.trim().replace(/^#/, '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** sRGB 0-255 to linear-light 0-1. The gamma curve, not a divide by 255. */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function delinearize(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return c * 255;
}

/** WCAG relative luminance. */
export function luminance(color: Rgb): number {
  return (
    0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b)
  );
}

/**
 * WCAG contrast ratio, 1..21.
 *
 * Order-independent by construction — lighter over darker — so a caller cannot
 * get a different answer by passing the pair the other way round.
 */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// ------------------------------------------------------------------ Lab --

/** Linear sRGB to CIE XYZ, D65. */
function toXyz(color: Rgb): [number, number, number] {
  const r = linearize(color.r);
  const g = linearize(color.g);
  const b = linearize(color.b);
  return [
    r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    r * 0.0193339 + g * 0.119192 + b * 0.9503041,
  ];
}

/** CIE L*a*b*, D65 white point. */
export function toLab(color: Rgb): [number, number, number] {
  const [x, y, z] = toXyz(color);
  const white = [0.95047, 1, 1.08883];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x / white[0]!);
  const fy = f(y / white[1]!);
  const fz = f(z / white[2]!);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * CIEDE2000 colour difference.
 *
 * The modern standard rather than plain Euclidean distance in Lab, which badly
 * overstates differences in the blues — and this palette is built on a teal.
 * Stated explicitly because a ΔE figure means nothing without its formula.
 */
export function deltaE2000(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);

  const avgL = (l1 + l2) / 2;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const avgC = (c1 + c2) / 2;

  const g = 0.5 * (1 - Math.sqrt(avgC ** 7 / (avgC ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + g);
  const a2p = a2 * (1 + g);
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const avgCp = (c1p + c2p) / 2;

  const deg = (rad: number) => (rad * 180) / Math.PI;
  const rad = (d: number) => (d * Math.PI) / 180;
  const hp = (ap: number, bb: number) => {
    if (ap === 0 && bb === 0) return 0;
    const h = deg(Math.atan2(bb, ap));
    return h >= 0 ? h : h + 360;
  };
  const h1p = hp(a1p, b1);
  const h2p = hp(a2p, b2);

  const dLp = l2 - l1;
  const dCp = c2p - c1p;

  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(rad(dhp) / 2);

  let avgHp = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) avgHp += h1p + h2p < 360 ? 360 : -360;
    avgHp /= 2;
  }

  const t =
    1 -
    0.17 * Math.cos(rad(avgHp - 30)) +
    0.24 * Math.cos(rad(2 * avgHp)) +
    0.32 * Math.cos(rad(3 * avgHp + 6)) -
    0.2 * Math.cos(rad(4 * avgHp - 63));

  const sl = 1 + (0.015 * (avgL - 50) ** 2) / Math.sqrt(20 + (avgL - 50) ** 2);
  const sc = 1 + 0.045 * avgCp;
  const sh = 1 + 0.015 * avgCp * t;
  const rt =
    -2 *
    Math.sqrt(avgCp ** 7 / (avgCp ** 7 + 25 ** 7)) *
    Math.sin(rad(60 * Math.exp(-(((avgHp - 275) / 25) ** 2))));

  return Math.sqrt(
    (dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh),
  );
}

// ------------------------------------------------- colour vision deficiency --

export type Cvd = 'deuteranopia' | 'protanopia';

/**
 * Simulate dichromatic vision (Viénot, Brettel & Mollon 1999).
 *
 * Applied in LINEAR light, not on the 0-255 values. Doing it on gamma-encoded
 * channels is the common shortcut and it produces visibly wrong colours, which
 * would make the ΔE floor below meaningless.
 *
 * Two types, not three: deuteranopia and protanopia together cover the large
 * majority, and §14.1 measured against exactly these.
 */
export function simulateCvd(color: Rgb, kind: Cvd): Rgb {
  const r = linearize(color.r);
  const g = linearize(color.g);
  const b = linearize(color.b);

  // linear sRGB -> LMS
  const l = 0.31399022 * r + 0.63951294 * g + 0.04649755 * b;
  const m = 0.15537241 * r + 0.75789446 * g + 0.08670142 * b;
  const s = 0.01775239 * r + 0.10944209 * g + 0.87256922 * b;

  let l2 = l;
  let m2 = m;
  const s2 = s;
  if (kind === 'protanopia') l2 = 1.05118294 * m - 0.05116099 * s;
  else m2 = 0.9513092 * l + 0.04866992 * s;

  // LMS -> linear sRGB
  const rr = 5.47221206 * l2 - 4.6419601 * m2 + 0.16963708 * s2;
  const gg = -1.1252419 * l2 + 2.29317094 * m2 - 0.1678952 * s2;
  const bb = 0.02980165 * l2 - 0.19318073 * m2 + 1.16364789 * s2;

  return { r: delinearize(rr), g: delinearize(gg), b: delinearize(bb) };
}

/** Convenience: contrast between two hex strings. */
export function contrastHex(a: string, b: string): number {
  return contrast(parseHex(a), parseHex(b));
}

/** Convenience: ΔE2000 between two hex strings, optionally under CVD. */
export function deltaEHex(a: string, b: string, cvd?: Cvd): number {
  const ca = cvd ? simulateCvd(parseHex(a), cvd) : parseHex(a);
  const cb = cvd ? simulateCvd(parseHex(b), cvd) : parseHex(b);
  return deltaE2000(ca, cb);
}
