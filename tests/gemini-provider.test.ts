import { describe, expect, it, vi } from 'vitest';
import { GeminiBrowserProvider, extractModelNames } from '../src/ai/gemini';
import { MODELS } from '../src/ai/models';
import { RateLimitedError } from '../src/core/queue';
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

describe('GeminiBrowserProvider.readDocument', () => {
  const pdf = { file: new Blob(['%PDF-1.4']), mime: 'application/pdf' };

  it('throws RateLimitedError on a 503 so the queue retries the read', async () => {
    // Observed live on a 10-page PDF: gemini-3.5-flash-lite answered 503
    // UNAVAILABLE ("high demand"), and the very next attempt after a 10s
    // backoff returned 200. A 503 is a wobble to wait out, not a failure —
    // treating it as fatal loses the whole document.
    const provider = new GeminiBrowserProvider('k', {
      fetchImpl: stubFetch(503, {
        error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' },
      }),
    });

    await expect(provider.readDocument(pdf)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('throws RateLimitedError on a 429 as well', async () => {
    const provider = new GeminiBrowserProvider('k', { fetchImpl: stubFetch(429, quota) });
    await expect(provider.readDocument(pdf)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('does not retry an invalid key — that is fatal, not transient', async () => {
    // Burning the 10/20/40s ladder on a key that will never work would make a
    // typo in Settings take 70 seconds to report.
    const provider = new GeminiBrowserProvider('bad', { fetchImpl: stubFetch(400, invalidKey) });
    await expect(provider.readDocument(pdf)).rejects.not.toBeInstanceOf(RateLimitedError);
  });

  it('reads pasted text without any model call at all', async () => {
    const spy = stubFetch(200, {});
    const provider = new GeminiBrowserProvider('k', { fetchImpl: spy });
    const result = await provider.readDocument({ text: 'Hello.\n\nWorld.' });

    expect((spy as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.readability).toBe(1);
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
    // returns 404 NOT_FOUND on the free tier — as do all the 2.5 models.
    //
    // The 503s, unlike the 404s, ROTATE. A later sweep the same day found
    // gemini-3.6-flash and gemini-3.8-flash — both previously recorded here as
    // permanently overloaded — serving in 2.5s and 7.8s, while the then-pinned
    // gemini-3.5-flash-lite had itself started returning 503. So this list is
    // "observed serving at some point", not a guarantee for right now; only the
    // 404s are treated as permanent.
    const VERIFIED_SERVING = [
      'gemini-3.5-flash', // 200, 10.4s
      'gemini-3.5-flash-lite', // 200 earlier, 503 later the same day
      'gemini-3.6-flash', // 200, 2.5s — current light
      'gemini-3.8-flash', // 200, 7.8s
      'gemini-3.7-flash', // 200, 10.8s
    ];
    const PERMANENTLY_GONE = [
      'gemini-2.5-pro', // 404 NOT_FOUND
      'gemini-2.5-flash', // 404 NOT_FOUND
      'gemini-2.5-flash-lite', // 404 NOT_FOUND
      'gemini-2.0-flash', // shut down
      'gemini-2.0-flash-lite', // shut down
    ];

    for (const id of Object.values(MODELS)) {
      expect(PERMANENTLY_GONE, `${id} does not exist on the free tier`).not.toContain(id);
      expect(VERIFIED_SERVING, `${id} has never been seen to serve a real call`).toContain(id);
    }
  });
});
