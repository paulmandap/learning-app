import { describe, expect, it } from 'vitest';
import { GeminiBrowserProvider } from '../src/ai/gemini';
import { MODELS } from '../src/ai/models';

/**
 * Live Gemini tests. SKIPPED unless LIVE_GEMINI=1.
 *
 * These are never required for CI to pass — the whole point of the fixture
 * suite is that correctness is provable without a key or a network. Run these
 * only when you want to confirm the real API still behaves as recorded:
 *
 *   LIVE_GEMINI=1 GEMINI_API_KEY=... npx vitest run tests/gemini-live.test.ts
 *
 * GEMINI_API_KEY is read here and ONLY here. The application never reads a
 * Gemini key from the environment — a user's key lives in profiles.gemini_api_key
 * under RLS (D12). This is test-harness input, not app configuration.
 */

const live = process.env.LIVE_GEMINI === '1';
const key = process.env.GEMINI_API_KEY ?? '';

describe.skipIf(!live)('live Gemini', () => {
  it('testConnection succeeds with a real key and returns usable models', async () => {
    expect(key, 'GEMINI_API_KEY must be set when LIVE_GEMINI=1').not.toBe('');

    const result = await new GeminiBrowserProvider(key).testConnection();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.models.length).toBeGreaterThan(0);
    // The two models this app actually pins must still exist and be usable.
    expect(result.models).toContain(MODELS.light);
    expect(result.models).toContain(MODELS.strong);
  }, 30_000);

  it('a bad key still maps to invalid_key against the real API', async () => {
    // Guards the assumption the whole error map rests on: that a rejected key
    // is a 400/INVALID_ARGUMENT and not something else Google changed to.
    const result = await new GeminiBrowserProvider('not-a-real-key').testConnection();
    expect(result).toEqual({ ok: false, reason: 'invalid_key' });
  }, 30_000);
});
