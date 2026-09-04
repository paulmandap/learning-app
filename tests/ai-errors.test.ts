import { describe, expect, it } from 'vitest';
import {
  classifyGeminiResponse,
  classifyThrownError,
  isRetryableStatus,
  reasonToMessage,
} from '../src/core/ai-errors';
import invalidKey from './fixtures/gemini-invalid-key.json';
import quota from './fixtures/gemini-quota.json';
import serverError from './fixtures/gemini-server-error.json';
import modelsOk from './fixtures/gemini-models-ok.json';

/**
 * No network. Every case is a recorded response shape.
 *
 * The invalid-key fixture is a VERBATIM capture from the live API during the
 * Phase 0 CORS gate — the reason this suite is worth anything is that it
 * asserts observed behaviour rather than the 401 everyone assumes.
 */
describe('classifyGeminiResponse', () => {
  it('treats 2xx as ok', () => {
    expect(classifyGeminiResponse(200, modelsOk)).toBe('ok');
    expect(classifyGeminiResponse(204, null)).toBe('ok');
  });

  it('detects an invalid key from the observed 400 / INVALID_ARGUMENT shape', () => {
    // The trap: this is a 400, not a 401 or 403.
    expect(invalidKey.error.code).toBe(400);
    expect(invalidKey.error.status).toBe('INVALID_ARGUMENT');
    expect(classifyGeminiResponse(400, invalidKey)).toBe('invalid_key');
  });

  it('does NOT call every 400 an invalid key', () => {
    // A malformed request is our bug, not the user's key. Telling the user to
    // check their key here would send them chasing the wrong thing.
    const malformed = {
      error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload received.' },
    };
    expect(classifyGeminiResponse(400, malformed)).toBe('unknown');
  });

  it('detects quota from 429', () => {
    expect(classifyGeminiResponse(429, quota)).toBe('quota');
  });

  it('detects quota from RESOURCE_EXHAUSTED on a non-429 status', () => {
    const body = { error: { code: 400, status: 'RESOURCE_EXHAUSTED', message: 'exhausted' } };
    expect(classifyGeminiResponse(400, body)).toBe('quota');
  });

  it('prefers quota over invalid_key when a quota message mentions the key', () => {
    // "quota exceeded for this API key" contains both signals; quota is the
    // truthful one and the key is fine.
    const body = {
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for this API key.' },
    };
    expect(classifyGeminiResponse(429, body)).toBe('quota');
  });

  it('maps 401 and 403 to invalid_key', () => {
    expect(classifyGeminiResponse(401, null)).toBe('invalid_key');
    expect(classifyGeminiResponse(403, null)).toBe('invalid_key');
  });

  it('maps server faults to unknown', () => {
    expect(classifyGeminiResponse(500, serverError)).toBe('unknown');
    expect(classifyGeminiResponse(503, null)).toBe('unknown');
  });

  it('survives a missing or unparseable body', () => {
    expect(classifyGeminiResponse(418, null)).toBe('unknown');
    expect(classifyGeminiResponse(400, undefined)).toBe('unknown');
    expect(classifyGeminiResponse(400, {})).toBe('unknown');
  });
});

describe('isRetryableStatus', () => {
  it('retries a 503 UNAVAILABLE — the failure that killed a real run', () => {
    // Observed live: gemini-3.8-flash returned this after 80s under load.
    // Treating it as fatal aborted a whole generation over a passing wobble.
    const overloaded = {
      error: {
        code: 503,
        status: 'UNAVAILABLE',
        message: 'This model is currently experiencing high demand.',
      },
    };
    expect(isRetryableStatus(503, overloaded)).toBe(true);
  });

  it('retries 429, 500 and 504', () => {
    expect(isRetryableStatus(429, null)).toBe(true);
    expect(isRetryableStatus(500, null)).toBe(true);
    expect(isRetryableStatus(504, null)).toBe(true);
  });

  it('retries on UNAVAILABLE even when the status code is unexpected', () => {
    expect(isRetryableStatus(200, { error: { status: 'UNAVAILABLE' } })).toBe(true);
  });

  it('does NOT retry a bad key or a malformed request', () => {
    // Retrying these just burns the daily quota to fail three times.
    expect(isRetryableStatus(400, invalidKey)).toBe(false);
    expect(isRetryableStatus(401, null)).toBe(false);
    expect(isRetryableStatus(403, null)).toBe(false);
    expect(isRetryableStatus(404, { error: { status: 'NOT_FOUND' } })).toBe(false);
  });
});

describe('classifyThrownError', () => {
  it('maps a thrown fetch failure to network', () => {
    expect(classifyThrownError(new TypeError('Failed to fetch'))).toBe('network');
  });

  it('maps an abort/timeout to network', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyThrownError(abort)).toBe('network');
  });
});

describe('reasonToMessage', () => {
  it('produces a distinct, non-technical message for each reason', () => {
    const messages = (['invalid_key', 'quota', 'network', 'unknown'] as const).map(reasonToMessage);
    expect(new Set(messages).size).toBe(4);
    for (const m of messages) {
      expect(m.length).toBeGreaterThan(0);
      // Spec rule: no technical words on any user-facing screen.
      expect(m).not.toMatch(/\b(OCR|pipeline|embedding|chunk|token|HTTP|API|JSON|4\d\d)\b/i);
    }
  });
});
