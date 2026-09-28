import { ICON_SHAPES, type IconName, type IconShape } from './icon-shapes';

/**
 * Icons as straight pieces, so they can be drawn with Views (NOTES §56.2).
 *
 * ## Why this exists
 *
 * The redesign needs about forty icons, and the owner chose to draw them rather
 * than add an icon package (+14 KB, two dependencies) or plain SVG (+1 KB, but
 * web-only) — *"try harder. draw boxes."* A View can be a ring, a rounded
 * frame, or a bar with round ends turned to any angle. That is enough for any
 * outline icon: a curve is a run of short round-ended bars laid end to end,
 * and where they meet, their round ends overlap into a round join — which is
 * exactly how Lucide strokes its lines (round caps, round joins).
 *
 * So circles and rectangles stay whole (one View each, perfectly smooth), and
 * every path is flattened here into bars short enough that no point of the
 * true curve is more than `TOLERANCE` from them. At 24 px that is a fifth of a
 * screen pixel on an iPhone — below what anybody can see.
 *
 * Pure geometry, no React Native: tested in tests/icons.test.ts.
 */

/** Furthest a flattened curve may stray from the real one, in icon units (the box is 24). */
export const TOLERANCE = 0.06;

/** Height of one row of a filled icon, in icon units. Its edge error is at most half of this, which the outline (0.875 either side of the line at 24 px) covers. */
export const FILL_ROW = 1.25;

export type Segment = readonly [x1: number, y1: number, x2: number, y2: number];
export interface Ring { cx: number; cy: number; r: number }
export interface Frame { x: number; y: number; w: number; h: number; r: number }

/** What a View-drawn icon is made of, in its 24-unit box. */
export interface IconPieces {
  /** Round-ended bars. A dot is a bar of no length. */
  segments: Segment[];
  rings: Ring[];
  frames: Frame[];
}

type Pt = [number, number];
interface Subpath { points: Pt[]; closed: boolean }

// ---------------------------------------------------------------- path parsing

const NUMBER = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/;

/**
 * Reads SVG path data. Written by hand because it has to take what Lucide
 * writes, including arc flags run together with the next number —
 * `a6 6 0 01-8.943 0` is flags 0 and 1, then -8.943.
 */
class Reader {
  private i = 0;
  constructor(private readonly s: string) {}
  private skip() {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i]!)) this.i++;
  }
  done() {
    this.skip();
    return this.i >= this.s.length;
  }
  atCommand() {
    this.skip();
    return /[A-Za-z]/.test(this.s[this.i] ?? '');
  }
  command() {
    this.skip();
    return this.s[this.i++]!;
  }
  number() {
    this.skip();
    const m = NUMBER.exec(this.s.slice(this.i));
    if (!m) throw new Error(`icon path: expected a number at ${this.i} in "${this.s}"`);
    this.i += m[0].length;
    return Number(m[0]);
  }
  flag() {
    this.skip();
    const c = this.s[this.i++];
    if (c !== '0' && c !== '1') throw new Error(`icon path: expected an arc flag at ${this.i - 1} in "${this.s}"`);
    return c === '1';
  }
}

function cubic(out: Pt[], p0: Pt, p1: Pt, p2: Pt, p3: Pt) {
  // Uniform steps: the chord error is at most 3/4 · |second difference| / n².
  const d = Math.max(
    Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]),
    Math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]),
  );
  const n = Math.max(1, Math.ceil(Math.sqrt((0.75 * d) / TOLERANCE)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

function quadratic(out: Pt[], p0: Pt, p1: Pt, p2: Pt) {
  const d = Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]);
  const n = Math.max(1, Math.ceil(Math.sqrt(d / (4 * TOLERANCE))));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
}

/** An SVG arc, by the endpoint-to-centre conversion in SVG 1.1 appendix F.6.5. */
function arc(out: Pt[], from: Pt, rxIn: number, ryIn: number, angle: number, large: boolean, sweep: boolean, to: Pt) {
  if (from[0] === to[0] && from[1] === to[1]) return;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!rx || !ry) {
    out.push(to);
    return;
  }
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from[0] - to[0]) / 2;
  const dy = (from[1] - to[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const grow = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (grow > 1) {
    rx *= Math.sqrt(grow);
    ry *= Math.sqrt(grow);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (k * rx * y1) / ry;
  const cyp = (-k * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (from[0] + to[0]) / 2;
  const cy = sin * cxp + cos * cyp + (from[1] + to[1]) / 2;
  const between = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1 - cxp) / rx;
  const uy = (y1 - cyp) / ry;
  const start = between(1, 0, ux, uy);
  let delta = between(ux, uy, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const r = Math.max(rx, ry);
  const step = 2 * Math.acos(Math.max(-1, 1 - TOLERANCE / r));
  const n = Math.max(1, Math.ceil(Math.abs(delta) / step));
  for (let i = 1; i < n; i++) {
    const t = start + (delta * i) / n;
    out.push([cx + cos * rx * Math.cos(t) - sin * ry * Math.sin(t), cy + sin * rx * Math.cos(t) + cos * ry * Math.sin(t)]);
  }
  out.push(to);
}

/** SVG path data → its subpaths, every curve flattened to points. */
export function flattenPath(d: string): Subpath[] {
  const r = new Reader(d);
  const paths: Subpath[] = [];
  // `as`, not an annotation: assigned inside moveTo, so TypeScript must not
  // narrow it to null from the initialiser.
  let cur = null as Subpath | null;
  let at: Pt = [0, 0];
  let start: Pt = [0, 0];
  // The last control point, for S and T, which reflect it.
  let lastCubic: Pt | null = null;
  let lastQuad: Pt | null = null;
  let cmd = '';

  const moveTo = (p: Pt) => {
    cur = { points: [p], closed: false };
    paths.push(cur);
    at = p;
    start = p;
  };
  const points = () => {
    if (!cur) moveTo(at);
    return cur!.points;
  };

  while (!r.done()) {
    if (r.atCommand()) cmd = r.command();
    else if (!cmd) throw new Error(`icon path: no command at the start of "${d}"`);
    const rel = cmd === cmd.toLowerCase();
    const X = (x: number) => (rel ? at[0] + x : x);
    const Y = (y: number) => (rel ? at[1] + y : y);
    const C = cmd.toUpperCase();
    let nextCubic: Pt | null = null;
    let nextQuad: Pt | null = null;

    if (C === 'M') {
      const x = r.number();
      const y = r.number();
      moveTo([X(x), Y(y)]);
      // Pairs after a moveto are linetos (SVG 1.1 §8.3.2).
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L') {
      const x = r.number();
      const y = r.number();
      at = [X(x), Y(y)];
      points().push(at);
    } else if (C === 'H') {
      at = [X(r.number()), at[1]];
      points().push(at);
    } else if (C === 'V') {
      at = [at[0], rel ? at[1] + r.number() : r.number()];
      points().push(at);
    } else if (C === 'C' || C === 'S') {
      let c1: Pt;
      if (C === 'C') {
        const x = r.number();
        const y = r.number();
        c1 = [X(x), Y(y)];
      } else {
        c1 = lastCubic ? [2 * at[0] - lastCubic[0], 2 * at[1] - lastCubic[1]] : at;
      }
      const c2x = r.number();
      const c2y = r.number();
      const c2: Pt = [X(c2x), Y(c2y)];
      const ex = r.number();
      const ey = r.number();
      const end: Pt = [X(ex), Y(ey)];
      cubic(points(), at, c1, c2, end);
      at = end;
      nextCubic = c2;
    } else if (C === 'Q' || C === 'T') {
      let c: Pt;
      if (C === 'Q') {
        const x = r.number();
        const y = r.number();
        c = [X(x), Y(y)];
      } else {
        c = lastQuad ? [2 * at[0] - lastQuad[0], 2 * at[1] - lastQuad[1]] : at;
      }
      const ex = r.number();
      const ey = r.number();
      const end: Pt = [X(ex), Y(ey)];
      quadratic(points(), at, c, end);
      at = end;
      nextQuad = c;
    } else if (C === 'A') {
      const rx = r.number();
      const ry = r.number();
      const rot = r.number();
      const large = r.flag();
      const sweep = r.flag();
      const ex = r.number();
      const ey = r.number();
      const end: Pt = [X(ex), Y(ey)];
      arc(points(), at, rx, ry, rot, large, sweep, end);
      at = end;
    } else if (C === 'Z') {
      if (cur) cur.closed = true;
      at = start;
      cur = null;
    } else {
      throw new Error(`icon path: unknown command "${cmd}" in "${d}"`);
    }
    lastCubic = nextCubic;
    lastQuad = nextQuad;
  }
  // A moveto with nothing after it draws nothing.
  return paths.filter((p) => p.points.length > 1);
}

/** Drops points that sit on the straight line between their neighbours. */
function simplify(points: Pt[]): Pt[] {
  if (points.length < 3) return points;
  const out: Pt[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cross) < 1e-9 && dot > 0) continue;
    out.push(b);
  }
  out.push(points[points.length - 1]!);
  return out;
}

function segmentsOf(path: Subpath): Segment[] {
  const pts = simplify(path.points);
  if (pts.length === 1) return [[pts[0]![0], pts[0]![1], pts[0]![0], pts[0]![1]]];
  const out: Segment[] = [];
  for (let i = 0; i < pts.length - 1; i++) out.push([pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1]]);
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (path.closed && (first[0] !== last[0] || first[1] !== last[1])) out.push([last[0], last[1], first[0], first[1]]);
  return out;
}

function piecesOf(shapes: readonly IconShape[]): IconPieces {
  const pieces: IconPieces = { segments: [], rings: [], frames: [] };
  for (const s of shapes) {
    if (s[0] === 'c') pieces.rings.push({ cx: s[1], cy: s[2], r: s[3] });
    else if (s[0] === 'r') pieces.frames.push({ x: s[1], y: s[2], w: s[3], h: s[4], r: s[5] });
    else if (s[0] === 'l') pieces.segments.push([s[1], s[2], s[3], s[4]]);
    else for (const path of flattenPath(s[1])) pieces.segments.push(...segmentsOf(path));
  }
  return pieces;
}

const piecesCache = new Map<IconName, IconPieces>();

/** An icon's outline, as Views will draw it. Worked out once per icon. */
export function iconPieces(name: IconName): IconPieces {
  let p = piecesCache.get(name);
  if (!p) {
    p = piecesOf(ICON_SHAPES[name]);
    piecesCache.set(name, p);
  }
  return p;
}

/**
 * A filled icon — a liked heart, a saved bookmark — as horizontal bands.
 *
 * Each band spans the shape where its middle line crosses it (even-odd, over
 * every path taken as closed). Its corners can stand at most half a band
 * outside the true edge, and the outline drawn over it covers that. Circles
 * and rectangles in a filled icon are filled whole instead.
 */
export type Band = readonly [x: number, y: number, w: number, h: number];

const fillCache = new Map<IconName, Band[]>();

export function iconFill(name: IconName): Band[] {
  const cached = fillCache.get(name);
  if (cached) return cached;
  const polygons: Pt[][] = [];
  for (const s of ICON_SHAPES[name]) if (s[0] === 'p') for (const p of flattenPath(s[1])) polygons.push(p.points);
  const ys = polygons.flat().map((p) => p[1]);
  const bands: Band[] = [];
  if (ys.length) {
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    for (let y = top; y < bottom; y += FILL_ROW) {
      const h = Math.min(FILL_ROW, bottom - y);
      const mid = y + h / 2;
      const xs: number[] = [];
      for (const poly of polygons) {
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i]!;
          const b = poly[(i + 1) % poly.length]!;
          if ((a[1] <= mid && b[1] > mid) || (b[1] <= mid && a[1] > mid)) {
            xs.push(a[0] + ((mid - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
          }
        }
      }
      xs.sort((p, q) => p - q);
      // A hair of overlap between rows, so no seam shows between two bands.
      for (let i = 0; i + 1 < xs.length; i += 2) bands.push([xs[i]!, y, xs[i + 1]! - xs[i]!, h + 0.05]);
    }
  }
  fillCache.set(name, bands);
  return bands;
}

/** How many Views an icon costs — held to a budget by tests/icons.test.ts. */
export function viewCount(name: IconName, filled = false): number {
  const p = iconPieces(name);
  return p.segments.length + p.rings.length + p.frames.length + (filled ? iconFill(name).length : 0);
}
