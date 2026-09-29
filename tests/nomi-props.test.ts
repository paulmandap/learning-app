import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLOATING,
  HEAD_TILT_DEG,
  holding,
  NOMI_PROPS,
  placeOf,
  PROP_PLACES,
  propsFor,
  stillWings,
  WORN,
} from '../src/core/nomi-props';
import { motionFor, NOMI_STATES } from '../src/core/nomi-motion';
import { isMorning } from '../src/core/nomi-brain';

/**
 * Nomi's props (NOTES §50), checked as data: every prop has a picture and a
 * place, and the right ones turn up in the right moments. What they look like on
 * the owl is checked by photographing them — the numbers in `PROP_PLACES` were
 * tuned that way.
 */

describe('every prop', () => {
  it('has a place on the owl, near enough to it to read as held, worn or beside it', () => {
    for (const name of NOMI_PROPS) {
      const p = PROP_PLACES[name];
      expect(p.cx, name).toBeGreaterThan(0);
      expect(p.cx, name).toBeLessThan(1.1);
      expect(p.cy, name).toBeGreaterThan(-0.1);
      expect(p.cy, name).toBeLessThan(1);
      expect(p.width, name).toBeGreaterThan(0.2);
      // A hat pulled down over the whole crown is as wide as the head and its
      // ear tufts (NOTES §68); nothing else is wider than most of the owl.
      expect(p.width, name).toBeLessThanOrEqual(WORN.has(name) ? 1.1 : 0.9);
      expect(Math.abs(p.rotate), name).toBeLessThanOrEqual(15);
    }
  });

  it('has a picture, cut by make-nomi-props.ts and listed in the art it wrote', () => {
    const art = readFileSync(join('src', 'ui', 'nomi-prop-art.ts'), 'utf8');
    for (const name of NOMI_PROPS) {
      expect(existsSync(join('assets', `nomi-prop-${name}.webp`)), name).toBe(true);
      expect(art, name).toMatch(new RegExp(`import ${name} from '\\.\\./\\.\\./assets/nomi-prop-${name}\\.webp';`));
      expect(art, name).toMatch(new RegExp(`\\b${name}: \\{ source: ${name}, width: \\d+, height: \\d+ \\}`));
    }
  });
});

describe('which prop, when', () => {
  it('floats a heart on a hop, sparkles on success and a lightbulb while Nomi speaks — and only then', () => {
    expect(propsFor('hop', null).floating).toBe('heart');
    expect(propsFor('success', null).floating).toBe('sparkles');
    expect(propsFor('explaining', null).floating).toBe('lightbulb');
    const floaters = NOMI_STATES.filter((s) => propsFor(s, null).floating !== null);
    expect(floaters.sort()).toEqual(['explaining', 'hop', 'success']);
    expect([...FLOATING].sort()).toEqual(['heart', 'lightbulb', 'sparkles']);
  });

  it('holds what the screen chose, through a hop', () => {
    expect(propsFor('studying', 'book')).toEqual({ held: 'book', floating: null });
    expect(propsFor('hop', 'mug')).toEqual({ held: 'mug', floating: 'heart' });
    expect(propsFor('idle', null)).toEqual({ held: null, floating: null });
  });

  it('wears its nightcap when sleepy, even if the screen chose nothing', () => {
    expect(propsFor('sleepy', null).held).toBe('nightcap');
    expect(propsFor('sleepy', 'mug').held).toBe('mug');
  });

  it('holds a mug from 5 until 9 in the morning', () => {
    expect([4, 5, 8, 9, 12].map(isMorning)).toEqual([false, true, true, false, false]);
  });
});

describe('worn and held, not stuck on (NOTES §68)', () => {
  it('wears a hat at the head’s own tilt — the cap was turned the other way', () => {
    // The head leans about 10° (the right ear tuft lower than the left).
    expect(HEAD_TILT_DEG).toBe(10);
    expect(PROP_PLACES.cap.rotate).toBe(HEAD_TILT_DEG);
    // The nightcap's picture already slopes ~10.6°; a little more meets the brow.
    expect(PROP_PLACES.nightcap.rotate).toBeGreaterThan(0);
    expect(PROP_PLACES.nightcap.rotate).toBeLessThan(5);
  });

  it('pulls the nightcap down over both ear tufts, not perched on top', () => {
    const n = PROP_PLACES.nightcap;
    // Wide enough to span the head, tufts and all.
    expect(n.width).toBeGreaterThanOrEqual(1);
    expect(n.cx - n.width / 2).toBeLessThanOrEqual(0.1);
  });

  it('keeps still the wings that hold something', () => {
    expect(stillWings('book')).toEqual(['wingLeft', 'wingRight']);
    expect(stillWings('mug')).toEqual(['wingLeft', 'wingRight']);
    expect(stillWings('pencil')).toEqual(['wingRight']);
    expect(stillWings('cap')).toEqual([]);
    expect(stillWings(null)).toEqual([]);
  });

  it('stretches with a mug without letting go of it — the wings stay, the rest plays', () => {
    const stretch = motionFor('stretch');
    const held = holding(stretch, 'mug');
    expect(stretch.tracks.map((t) => t.channel)).toContain('wingLeft');
    expect(held.tracks.map((t) => t.channel)).not.toContain('wingLeft');
    expect(held.tracks.map((t) => t.channel)).not.toContain('wingRight');
    expect(held.tracks.map((t) => t.channel)).toEqual(expect.arrayContaining(['lift', 'happy']));
    expect(held.duration).toBe(stretch.duration);
    // A hat holds nothing: the wave is still a wave.
    expect(holding(motionFor('greeting'), 'nightcap')).toEqual(motionFor('greeting'));
  });

  it('floats a heart, sparkles or a lightbulb clear of a hat, and close to the head without one', () => {
    for (const floating of FLOATING) {
      expect(placeOf(floating, null)).toEqual(PROP_PLACES[floating]);
      expect(placeOf(floating, 'mug')).toEqual(PROP_PLACES[floating]);
      for (const hat of WORN) {
        const above = placeOf(floating, hat);
        expect(above.cy, `${floating} with ${hat}`).toBeLessThan(PROP_PLACES[floating].cy);
        expect(above.cx, `${floating} with ${hat}`).toBeGreaterThan(1);
      }
    }
    // A held prop is where it always is.
    expect(placeOf('cap', 'nightcap')).toEqual(PROP_PLACES.cap);
  });
});
