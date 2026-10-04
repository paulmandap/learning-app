import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hydrate, QueryClient, type DehydratedState } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  buildIdFrom,
  KEPT_SCREENS,
  packSavedScreens,
  SAVED_SCREENS_MAX_AGE_MS,
  SAVED_SCREENS_MAX_CHARS,
  SAVED_SCREENS_VERSION,
  shouldKeep,
  unpackSavedScreens,
} from '../src/core/saved-screens';
import { holdsSplash, SPLASH_IGNORES } from '../src/core/splash';
import { EFFECTIVE_DATE, PRIVACY_POLICY, TERMS_EFFECTIVE_DATE, TERMS_OF_USE } from '../src/core/legal';
import { screensToKeep } from '../src/data/saved-screens';

/**
 * The main screens kept on this device, so the app opens at once (NOTES §71).
 *
 * The owner asked for it "at the cost of the user side and minimal effect on
 * my DB side". These hold what that must never cost: the Gemini key on the
 * device, one person's screens shown to another, an old build's answers fed to
 * a new one — and the database being asked for everything twice.
 */

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function packed(c: QueryClient, overrides: Partial<{ userId: string; build: string; savedAt: number }> = {}) {
  return packSavedScreens({
    userId: overrides.userId ?? 'person-a',
    build: overrides.build ?? 'build-1',
    savedAt: overrides.savedAt ?? 1_000_000,
    state: screensToKeep(c),
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('what is kept on the device', () => {
  it("keeps Home, Progress, Notes and Profile's own lines", () => {
    for (const key of [['nomi-brain'], ['sets'], ['continue'], ['folders'], ['dashboard'], ['notes'], ['my-username'], ['my-bio'], ['post-count', 'me']]) {
      expect(shouldKeep(key), JSON.stringify(key)).toBe(true);
    }
  });

  it('never the profile, a deck, a picture link, a conversation or a badge', () => {
    for (const key of [
      ['profile'],
      ['items', 'set-1', true],
      ['set', 'set-1'],
      ['schedules', 'set-1'],
      ['avatar-url', 'photo.jpg'],
      ['post-images', ['a.jpg']],
      ['direct-messages', 'c-1'],
      ['dm-unread'],
      ['standing'],
      [],
      [42],
    ]) {
      expect(shouldKeep(key), JSON.stringify(key)).toBe(false);
    }
  });

  it('every name kept is a query the app really makes — a renamed one would quietly stop being kept', () => {
    const code = [...sourceFiles('app'), ...sourceFiles('src')].map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const root of KEPT_SCREENS) expect(code, root).toContain(`queryKey: ['${root}'`);
    for (const root of SPLASH_IGNORES) expect(code, root).toContain(`queryKey: ['${root}'`);
  });

  it('never writes the Gemini key, whatever is in the cache', () => {
    const c = client();
    c.setQueryData(['profile'], { display_name: 'Paul', gemini_api_key: 'AIza-not-a-real-key' });
    c.setQueryData(['sets'], [{ id: 'set-1', title: 'Biology' }]);
    // A kept query that one day starts carrying the key is dropped too.
    c.setQueryData(['nomi-brain'], { displayName: 'Paul', gemini_api_key: 'AIza-not-a-real-key' });
    const text = packed(c);
    expect(text).not.toBeNull();
    expect(text).not.toContain('AIza-not-a-real-key');
    expect(text).not.toContain('gemini_api_key');
    expect(text).toContain('Biology');
  });

  it('only answers that arrived', () => {
    const state: DehydratedState = {
      mutations: [],
      queries: [
        {
          queryKey: ['sets'],
          queryHash: '["sets"]',
          state: {
            data: undefined,
            dataUpdateCount: 0,
            dataUpdatedAt: 0,
            error: new Error('offline') as never,
            errorUpdateCount: 1,
            errorUpdatedAt: 1,
            fetchFailureCount: 1,
            fetchFailureReason: null,
            fetchMeta: null,
            isInvalidated: false,
            status: 'error',
            fetchStatus: 'idle',
          },
        },
      ],
    };
    expect(packSavedScreens({ userId: 'person-a', build: 'build-1', savedAt: 1, state })).toBeNull();
  });

  it('too big: the notes go first, and the screens nearer the top stay', () => {
    const c = client();
    c.setQueryData(['sets'], [{ id: 'set-1', title: 'Biology' }]);
    c.setQueryData(['notes'], [{ id: 'note-1', body: 'x'.repeat(SAVED_SCREENS_MAX_CHARS) }]);
    const text = packed(c)!;
    expect(text.length).toBeLessThanOrEqual(SAVED_SCREENS_MAX_CHARS);
    expect(text).toContain('Biology');
    expect(text).not.toContain('note-1');

    const onlyNotes = client();
    onlyNotes.setQueryData(['notes'], [{ id: 'note-1', body: 'x'.repeat(SAVED_SCREENS_MAX_CHARS) }]);
    expect(packed(onlyNotes)).toBeNull();
  });
});

describe('putting it back', () => {
  const T = 1_800_000_000_000;
  const c = client();
  c.setQueryData(['sets'], [{ id: 'set-1', title: 'Biology' }]);
  const raw = packed(c, { savedAt: T })!;

  it('for the same person and build, within a week — and the screen gets exactly what was kept', () => {
    const state = unpackSavedScreens(raw, { userId: 'person-a', build: 'build-1', now: T + 60_000 });
    expect(state).not.toBeNull();
    const fresh = client();
    hydrate(fresh, state!);
    expect(fresh.getQueryData(['sets'])).toEqual([{ id: 'set-1', title: 'Biology' }]);
  });

  it("never another person's, another build's, an old one, or one dated in the future", () => {
    expect(unpackSavedScreens(raw, { userId: 'person-b', build: 'build-1', now: T })).toBeNull();
    expect(unpackSavedScreens(raw, { userId: 'person-a', build: 'build-2', now: T })).toBeNull();
    expect(unpackSavedScreens(raw, { userId: 'person-a', build: 'build-1', now: T + SAVED_SCREENS_MAX_AGE_MS + 1 })).toBeNull();
    expect(unpackSavedScreens(raw, { userId: 'person-a', build: 'build-1', now: T - 1 })).toBeNull();
    expect(unpackSavedScreens(raw, { userId: '', build: 'build-1', now: T })).toBeNull();
  });

  it('nothing from storage that is unreadable, or saved in another shape', () => {
    const now = { userId: 'person-a', build: 'build-1', now: T };
    expect(unpackSavedScreens(null, now)).toBeNull();
    expect(unpackSavedScreens('{not json', now)).toBeNull();
    expect(unpackSavedScreens('{"v":1}', now)).toBeNull();
    const older = JSON.stringify({ ...JSON.parse(raw), v: SAVED_SCREENS_VERSION + 1 });
    expect(unpackSavedScreens(older, now)).toBeNull();
  });

  it('a build is told apart by its main script, and anything else counts as the dev server', () => {
    expect(buildIdFrom(['https://learning-app-6kk.pages.dev/_expo/static/js/web/entry-8ff20d60db45aa591e1974a4448ed412.js'])).toBe(
      '8ff20d60db45aa591e1974a4448ed412',
    );
    expect(buildIdFrom(['http://localhost:8081/node_modules/expo-router/entry.bundle?platform=web'])).toBe('dev');
    expect(buildIdFrom([])).toBe('dev');
  });
});

describe('the splash and what was put back (NOTES §71)', () => {
  it('waits for what the screen has nothing for — not for a refresh, a badge, a notice or a photo link', () => {
    expect(holdsSplash(['sets'], false)).toBe(true);
    expect(holdsSplash(['profile'], false)).toBe(true);
    expect(holdsSplash(['sets'], true)).toBe(false);
    expect(holdsSplash(['dm-unread'], false)).toBe(false);
    expect(holdsSplash(['standing'], false)).toBe(false);
    expect(holdsSplash(['avatar-url', 'me.jpg'], false)).toBe(false);
  });
});

describe('wired in', () => {
  const layout = read('app', '_layout.tsx');
  const session = read('src', 'data', 'session.ts');
  const settings = read('app', 'settings.tsx');

  it('put back with the first answer about who is signed in, before the store hears it', () => {
    expect(layout).toContain('onFirstSession: (session) => void restoreSavedScreens(queryClient, session?.user.id ?? null)');
    expect(session).toMatch(/options\.onFirstSession\?\.\(session\)[\s\S]*?setSession\(session\);\s*markReady\(\);/);
    expect(layout).toContain('keepSavingScreens(queryClient,');
  });

  it('the first answer is not a change of person — Home was asked for twice on every open', () => {
    const reset = layout.slice(layout.indexOf('function useResetCacheOnUserChange'));
    expect(reset).toMatch(/if \(!ready\) return;[\s\S]*?forgetSavedScreens\(\);[\s\S]*?resetQueries\(\)/);
  });

  it('removed on signing out and on Delete my data', () => {
    const signOut = settings.slice(settings.indexOf('label="Sign out"'));
    expect(signOut.slice(0, signOut.indexOf('signOut()'))).toContain('forgetSavedScreens();');
    const del = settings.slice(settings.indexOf('async function reallyDelete'));
    expect(del.slice(0, del.indexOf('invalidateQueries'))).toContain('forgetSavedScreens();');
  });

  it('the splash counts only what holds it', () => {
    expect(layout).toContain('predicate: (query) => holdsSplash(query.queryKey, query.state.data !== undefined)');
  });

  it('kept answers stay in memory a day, so an unopened screen is still there to keep', () => {
    expect(layout).toContain('queryClient.setQueryDefaults([root], { gcTime: KEPT_SCREENS_GC_MS })');
  });
});

describe('the Privacy Policy says so', () => {
  const text = PRIVACY_POLICY.sections.flatMap((s) => s.body.flat()).join('\n');

  it('names the copy, says what is in it, and that signing out removes it', () => {
    expect(text).toContain('keeps a copy of your profile picture and of what your main screens last showed, such as your sets, notes and progress');
    expect(text).toContain('Signing out removes both copies.');
    expect(PRIVACY_POLICY.effective).toBe(EFFECTIVE_DATE);
  });

  it('the Terms of Use did not change, and keep their date', () => {
    expect(TERMS_OF_USE.effective).toBe(TERMS_EFFECTIVE_DATE);
    expect(TERMS_EFFECTIVE_DATE).toBe('September 29, 2026');
  });
});

describe('the code is kept by phones (NOTES §71)', () => {
  const headers = read('public', '_headers');

  it('built files, whose names change with their contents, for a year', () => {
    for (const path of ['/_expo/static/*', '/assets/*']) {
      expect(headers).toMatch(new RegExp(`^${path.replace(/[.*/]/g, '\\$&')}\\n  Cache-Control: public, max-age=31536000, immutable$`, 'm'));
    }
  });

  it('and nothing else: index.html must be asked about every time, or a deploy never arrives', () => {
    const rules = headers.split('\n').filter((line) => line.startsWith('/'));
    expect(rules).toEqual(['/_expo/static/*', '/assets/*']);
  });
});
