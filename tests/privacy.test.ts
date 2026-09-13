import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The privacy notice (NOTES §37), read as source: `src/data/profile.ts` imports
 * the Supabase client, which needs the environment, and what matters here is
 * that three places agree on two strings.
 */
describe('the privacy notice is remembered in one place', () => {
  it('the screenshot harness marks the same key the app reads', () => {
    const profile = readFileSync('src/data/profile.ts', 'utf8');
    const harness = readFileSync('scripts/screenshot.ts', 'utf8');
    const key = profile.match(/return `(privacy-notice-accepted:)\$\{userId\}`/)?.[1];
    expect(key).toBe('privacy-notice-accepted:');
    expect(harness).toContain(`'${key}' + s.user.id`);
  });

  it('migration 0017 adds the column the app selects, and removes nothing', () => {
    const sql = readFileSync('supabase/migrations/0017_privacy_notice.sql', 'utf8').replace(/--.*$/gm, '');
    expect(sql).toMatch(/add column if not exists privacy_accepted_at timestamptz/);
    expect(sql).not.toMatch(/\bdrop\b|\brename\b/i);
    expect(readFileSync('src/data/profile.ts', 'utf8')).toContain('privacy_accepted_at, created_at');
  });
});
