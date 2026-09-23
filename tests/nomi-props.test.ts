import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLOATING, NOMI_PROPS, PROP_PLACES, propsFor } from '../src/core/nomi-props';
import { NOMI_STATES } from '../src/core/nomi-motion';
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
      expect(p.width, name).toBeLessThanOrEqual(0.9);
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
