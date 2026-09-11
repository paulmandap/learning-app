import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Boot smoke test: does the built bundle actually MOUNT?
 *
 * This exists because a React version mismatch (react 19.2.8 vs react-dom
 * 19.2.3) once shipped to production as a blank white page. Every other test
 * passed, the build succeeded, and the URL returned HTTP 200 — because none of
 * them ever executed the bundle. A page that renders nothing still returns 200.
 *
 * Runs against ./dist, so it only means something after `expo export`. It is
 * skipped rather than failed when dist is absent, so `vitest run` on a clean
 * checkout is not a false alarm.
 *
 * ## REQUIRE_BUILD, and why skipping is not acceptable everywhere
 *
 * Skipping is right for a developer who has not built yet and wrong for CI:
 * these five checks exist because a blank white page reached production while
 * every other check passed, and a run that quietly skips them reports success
 * for exactly the thing they were written to catch. Silently doing nothing is
 * the failure mode this project has paid for four times.
 *
 * So the skip stays local and `REQUIRE_BUILD=1` turns a missing build into a
 * failure. The CI workflow sets it and runs `expo export` first. Nothing about
 * the checks themselves changes — only whether their absence is allowed to
 * pass unnoticed.
 */

const DIST = 'dist';
const BUNDLE_DIR = join(DIST, '_expo/static/js/web');
const hasBuild = existsSync(join(DIST, 'index.html')) && existsSync(BUNDLE_DIR);
const requireBuild = process.env.REQUIRE_BUILD === '1';

describe.runIf(requireBuild)('the build these checks need', () => {
  it('is there, so the boot checks below actually ran', () => {
    expect(
      hasBuild,
      `REQUIRE_BUILD=1 but ${DIST} has no bundle — run \`npm run export:web\` before the tests. ` +
        'Skipping here would report a pass for the checks that catch a white screen.',
    ).toBe(true);
  });
});

describe.skipIf(!hasBuild)('built web bundle', () => {
  it('has exactly one React version (mismatch = blank page)', () => {
    const bundle = readBundle();
    const versions = [...new Set(bundle.match(/19\.\d+\.\d+/g) ?? [])];
    // React 19 throws error #527 and renders nothing when react and react-dom
    // disagree, so more than one version here is a shipped white screen.
    expect(versions.length).toBeLessThanOrEqual(1);
  });

  it('index.html carries the PWA metadata and a root element', () => {
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    expect(html).toContain('id="root"');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html).toContain('apple-touch-icon');
  });

  it('ships the SPA fallback that web.output "single" requires', () => {
    // Without this, a refresh on /settings is a 404 on Cloudflare.
    const redirects = readFileSync(join(DIST, '_redirects'), 'utf8');
    expect(redirects).toMatch(/\/\*\s+\/index\.html\s+200/);
  });

  it('contains no real credential values', () => {
    const bundle = readBundle();
    // The publishable key is expected (RLS-bound, safe). These are not.
    expect(bundle).not.toMatch(/sb_secret_[A-Za-z0-9_-]{10,}/);
    expect(bundle).not.toMatch(/sbp_[a-f0-9]{40}/);
    expect(bundle).not.toMatch(/cfut_[A-Za-z0-9]{20,}/);
  });

  it('MOUNTS: executing the bundle fills #root with real content', async () => {
    const { JSDOM } = await import('jsdom');

    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://learning-app-6kk.pages.dev/',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });

    const { window } = dom;
    const errors: string[] = [];
    window.addEventListener('error', (e: Event) =>
      errors.push((e as ErrorEvent).message ?? 'unknown'),
    );

    // Shims for browser APIs react-native-web touches that jsdom lacks.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    // jsdom implements neither of these; react-native-web uses both for layout.
    // Shimming them is emulating a browser, not papering over an app bug.
    Object.defineProperty(window, 'ResizeObserver', {
      writable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
    Object.defineProperty(window, 'IntersectionObserver', {
      writable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    });
    Object.defineProperty(window, 'fetch', {
      writable: true,
      value: async () => new Response('{}', { status: 200 }),
    });

    try {
      window.eval(readBundle());
    } catch (err) {
      throw new Error(
        `Bundle threw while executing — this is the blank-page failure:\n${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`,
      );
    }

    // React renders synchronously enough for the first paint; give microtasks
    // and any effect-scheduled work a chance to land.
    await new Promise((r) => setTimeout(r, 500));

    const root = window.document.getElementById('root');
    expect(errors, `uncaught errors during boot: ${errors.join('; ')}`).toEqual([]);
    expect(root, 'no #root element').not.toBeNull();
    expect(
      (root?.innerHTML ?? '').length,
      'the app mounted nothing into #root — this is a white screen',
    ).toBeGreaterThan(0);

    dom.window.close();
  }, 60_000);
});

function readBundle(): string {
  const file = readdirSync(BUNDLE_DIR).find((f) => f.endsWith('.js'));
  if (!file) throw new Error(`No JS bundle in ${BUNDLE_DIR}`);
  return readFileSync(join(BUNDLE_DIR, file), 'utf8');
}
