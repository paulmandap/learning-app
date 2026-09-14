import { describe, expect, it } from 'vitest';
import { GeminiBrowserProvider } from '../src/ai/gemini';
import { LABEL_MODEL, LIGHT_LADDER } from '../src/ai/models';
import { RateLimitedError } from '../src/core/queue';

/**
 * Locating a picture's labels (NOTES §44), with an injected fetch — no network.
 * The one property that matters here: only the measured model is ever asked.
 */

const picture = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

function recordingFetch(status: number, body: unknown) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

const reply = (payload: unknown) => ({
  candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }],
});

describe('GeminiBrowserProvider.locateLabels', () => {
  it('asks the measured model, and returns the positions it gives', async () => {
    const { urls, fetchImpl } = recordingFetch(200, reply({ labels: [{ text: 'Accumulator', box_2d: [710, 620, 760, 750] }] }));
    const provider = new GeminiBrowserProvider('k', { fetchImpl });

    expect(await provider.locateLabels({ file: picture, mime: 'image/png' })).toEqual([
      { text: 'Accumulator', box: [710, 620, 760, 750] },
    ]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/models/${LABEL_MODEL}:generateContent`);
  });

  it('never falls back to the backup models when the measured one is busy', async () => {
    const { urls, fetchImpl } = recordingFetch(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'high demand' } });
    const provider = new GeminiBrowserProvider('k', { fetchImpl });

    await expect(provider.locateLabels({ file: picture, mime: 'image/png' })).rejects.toBeInstanceOf(RateLimitedError);
    expect(urls).toHaveLength(1);
    for (const backup of LIGHT_LADDER.filter((m) => m !== LABEL_MODEL)) {
      expect(urls.some((u) => u.includes(backup))).toBe(false);
    }
  });

  it('returns null for positions in the wrong units', async () => {
    const { fetchImpl } = recordingFetch(200, reply({ labels: [{ text: 'Bus', box_2d: [0.1, 0.2, 0.3, 0.4] }] }));
    const provider = new GeminiBrowserProvider('k', { fetchImpl });
    expect(await provider.locateLabels({ file: picture, mime: 'image/png' })).toBeNull();
  });
});
