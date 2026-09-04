import { describe, expect, it, vi } from 'vitest';
import { GeminiBrowserProvider, extractModelNames } from '../src/ai/gemini';
import { MODELS } from '../src/ai/models';
import modelsOk from './fixtures/gemini-models-ok.json';
import invalidKey from './fixtures/gemini-invalid-key.json';
import quota from './fixtures/gemini-quota.json';

/**
 * The provider is exercised with an injected fetch. Nothing here touches the
 * network — that is a hard requirement of the spec's test plan, and it is what
 * makes these tests safe to run in CI with no key.
 */

function stubFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('GeminiBrowserProvider.testConnection', () => {
  it('returns the usable model list on success', async () => {
    const provider = new GeminiBrowserProvider('k', { fetchImpl: stubFetch(200, modelsOk) });
    const result = await provider.testConnection();

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The embedding model is filtered out: a key that can only embed cannot
      // make cards, and reporting success for it would be a lie.
      expect(result.models).toEqual(['gemini-3.8-flash', 'gemini-2.5-pro']);
    }
  });

  it('maps the real invalid-key response to invalid_key', async () => {
    const provider = new GeminiBrowserProvider('bad', { fetchImpl: stubFetch(400, invalidKey) });
    const result = await provider.testConnection();
    expect(result).toEqual({ ok: false, reason: 'invalid_key' });
  });

  it('maps a 429 to quota', async () => {
    const provider = new GeminiBrowserProvider('k', { fetchImpl: stubFetch(429, quota) });
    const result = await provider.testConnection();
    expect(result).toEqual({ ok: false, reason: 'quota' });
  });

  it('maps a thrown fetch to network', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const provider = new GeminiBrowserProvider('k', { fetchImpl: failing });
    const result = await provider.testConnection();
    expect(result).toEqual({ ok: false, reason: 'network' });
  });

  it('maps a 500 to unknown', async () => {
    const provider = new GeminiBrowserProvider('k', { fetchImpl: stubFetch(500, {}) });
    const result = await provider.testConnection();
    expect(result).toEqual({ ok: false, reason: 'unknown' });
  });

  it('survives a non-JSON error body without throwing', async () => {
    const html = vi.fn(async () =>
      new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    ) as unknown as typeof fetch;
    const provider = new GeminiBrowserProvider('k', { fetchImpl: html });
    const result = await provider.testConnection();
    expect(result).toEqual({ ok: false, reason: 'unknown' });
  });

  it('sends only the x-goog-api-key header', async () => {
    // Header discipline is what keeps the browser preflight passing. Any extra
    // custom header risks a preflight the endpoint will not answer.
    const spy = stubFetch(200, modelsOk);
    const provider = new GeminiBrowserProvider('secret-key', { fetchImpl: spy });
    await provider.testConnection();

    const call = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeDefined();
    const init = call![1] as RequestInit;
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['x-goog-api-key']);
    expect(init.method).toBe('GET');
  });

  it('never puts the key in the returned failure', async () => {
    const provider = new GeminiBrowserProvider('super-secret', {
      fetchImpl: stubFetch(400, invalidKey),
    });
    const result = await provider.testConnection();
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });
});

describe('extractModelNames', () => {
  it('strips the models/ prefix and drops non-generative models', () => {
    expect(extractModelNames(modelsOk)).toEqual(['gemini-3.8-flash', 'gemini-2.5-pro']);
  });

  it('returns an empty list for junk input', () => {
    expect(extractModelNames(null)).toEqual([]);
    expect(extractModelNames({})).toEqual([]);
    expect(extractModelNames({ models: 'nope' })).toEqual([]);
    expect(extractModelNames({ models: [{}, { name: 42 }] })).toEqual([]);
  });
});

describe('MODELS config', () => {
  it('pins explicit IDs, never floating aliases or shut-down models', () => {
    for (const id of Object.values(MODELS)) {
      expect(id).not.toMatch(/latest/); // a moving target breaks reproducibility
      expect(id).not.toMatch(/preview/); // more restrictive limits, unapproved
      expect(id).not.toBe('gemini-2.0-flash'); // shut down
      expect(id).not.toBe('gemini-2.0-flash-lite'); // shut down
    }
  });

  it('uses only models proven to SERVE generateContent, not merely listed', () => {
    // This assertion previously required gemini-2.5-pro because the docs and
    // models.list both offered it. Probing generateContent directly showed it
    // returns 404 NOT_FOUND on the free tier — as do all the 2.5 models — while
    // the two newest Flash models were 503 overloaded. Availability in
    // models.list means nothing; only a real call does.
    const VERIFIED_SERVING = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];
    const KNOWN_UNUSABLE = [
      'gemini-2.5-pro', // 404 NOT_FOUND
      'gemini-2.5-flash', // 404 NOT_FOUND
      'gemini-2.5-flash-lite', // 404 NOT_FOUND
      'gemini-3.8-flash', // 503 UNAVAILABLE (overloaded)
      'gemini-3.6-flash', // 503 UNAVAILABLE (overloaded)
    ];

    for (const id of Object.values(MODELS)) {
      expect(KNOWN_UNUSABLE, `${id} was observed unusable on the free tier`).not.toContain(id);
      expect(VERIFIED_SERVING).toContain(id);
    }
  });
});
