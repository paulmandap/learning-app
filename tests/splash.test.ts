import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOMI_RIG } from '../src/ui/nomi-rig';
import { SPLASH_VARIANTS, splashRigBlock, withSplashRig } from '../src/core/splash';

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
