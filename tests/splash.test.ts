import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOMI_RIG } from '../src/ui/nomi-rig';
import {
  shouldHideSplash,
  SPLASH_DATA_WAIT_MS,
  SPLASH_MIN_MS,
  SPLASH_NOTHING_TO_LOAD_MS,
  SPLASH_SETTLE_MS,
  SPLASH_VARIANTS,
  splashRigBlock,
  withSplashRig,
  type SplashMoment,
} from '../src/core/splash';

/**
 * The splash in public/index.html (NOTES §42, §43).
 *
 * It is plain HTML and CSS, shown before the app's JavaScript has loaded, so
 * nothing at run time keeps it in step with the character. This does: the
 * pivots and eye lines it animates about must be the rig the app uses, every
 * layer it draws must be there, and the variants must be the ones listed.
 */

const html = readFileSync(join('public', 'index.html'), 'utf8');

describe('the splash', () => {
  it('attaches the moving parts where the app does — the rig block is NOMI_RIG', () => {
    // Stale after a re-cut of Nomi until `npx tsx scripts/make-splash.ts` runs.
    expect(html).toContain(splashRigBlock(NOMI_RIG));
  });

  it('has every layer it draws, under a name plain HTML can reach', () => {
    for (const name of ['body', 'eye-left', 'eye-right', 'wing-left', 'wing-right']) {
      expect(html, name).toContain(`src="/nomi/${name}.webp"`);
      expect(existsSync(join('public', 'nomi', `${name}.webp`)), name).toBe(true);
    }
    expect(existsSync(join('public', 'nomi-splash.webp'))).toBe(false);
  });

  it('picks one of the listed variants — never idle, never the one shown last time', () => {
    const listed = html.match(/var variants = (\[[^\]]*\]);/)?.[1];
    expect(listed).toBeDefined();
    expect(JSON.parse(listed!.replace(/'/g, '"'))).toEqual([...SPLASH_VARIANTS]);
    expect(SPLASH_VARIANTS).not.toContain('idle');
    expect(html).toContain('return v !== last;');
    for (const variant of SPLASH_VARIANTS) expect(html, variant).toContain(`#splash.v-${variant}`);
  });

  it('sits in the page before the app, and holds still under reduce motion', () => {
    expect(html.indexOf('id="splash"')).toBeLessThan(html.indexOf('id="root"'));
    expect(html).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*#splash \*, #splash \{ animation: none !important;/);
  });

  it('refuses a page without its markers rather than quietly writing nothing', () => {
    expect(() => withSplashRig('<html><head></head></html>', NOMI_RIG)).toThrow(/markers/);
  });
});

describe('when the splash goes (NOTES §45)', () => {
  // Signed in, the first screen's data just in: the moment it should go.
  const settled: SplashMoment = {
    sinceLoad: 2000,
    sinceReady: 600,
    signedIn: true,
    fetching: 0,
    idleFor: SPLASH_SETTLE_MS,
    sawWork: true,
  };

  it('goes once the first screen has what it asked for', () => {
    expect(shouldHideSplash(settled)).toBe(true);
  });

  it('stays while the first screen is still loading — the "Loading…" it used to reveal', () => {
    expect(shouldHideSplash({ ...settled, fetching: 3, idleFor: 0 })).toBe(false);
    // The moment between one answer and the request it starts.
    expect(shouldHideSplash({ ...settled, idleFor: SPLASH_SETTLE_MS - 1 })).toBe(false);
  });

  it('stays until the app knows who is signed in, and for one whole gesture', () => {
    expect(shouldHideSplash({ ...settled, sinceReady: null })).toBe(false);
    expect(shouldHideSplash({ ...settled, sinceLoad: SPLASH_MIN_MS - 1 })).toBe(false);
  });

  it('never holds anyone on a slow network past its limit', () => {
    expect(shouldHideSplash({ ...settled, fetching: 2, idleFor: 0, sinceReady: SPLASH_DATA_WAIT_MS })).toBe(true);
  });

  it('does not wait for data that sign-in, or a screen with nothing to load, never asks for', () => {
    expect(shouldHideSplash({ ...settled, signedIn: false, sawWork: false, idleFor: 0, sinceReady: 0 })).toBe(true);
    expect(shouldHideSplash({ ...settled, sawWork: false, sinceReady: SPLASH_NOTHING_TO_LOAD_MS - 1 })).toBe(false);
    expect(shouldHideSplash({ ...settled, sawWork: false, sinceReady: SPLASH_NOTHING_TO_LOAD_MS })).toBe(true);
  });
});
