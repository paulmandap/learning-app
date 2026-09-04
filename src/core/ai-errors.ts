/**
 * Deterministic classification of Gemini API failures.
 *
 * Pure: no fetch, no react-native, no expo. Given a status code and a parsed
 * body it returns one of the four reasons the spec's AIProvider allows.
 *
 * The mapping is grounded in *observed* API behaviour, not assumption. The
 * Phase 0 CORS probe showed an invalid key returns:
 *
 *   HTTP 400  {"error":{"code":400,"status":"INVALID_ARGUMENT",
 *              "message":"API key not valid. Please pass a valid API key."}}
 *
 * — not the 401/403 a reasonable implementer would guess. A plain 400 is
 * therefore ambiguous: it means "bad key" only when the payload says so,
 * and otherwise means we sent a malformed request, which is 'unknown'.
 */

export type FailureReason = 'invalid_key' | 'quota' | 'network' | 'unknown';

/** The error shape Google returns. Every field is optional in practice. */
export interface GeminiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

const KEY_HINTS = [
  'api key not valid',
  'api key expired',
  'invalid api key',
  'api_key_invalid',
  'please pass a valid api key',
];

const QUOTA_HINTS = [
  'quota',
  'rate limit',
  'resource has been exhausted',
  'resource_exhausted',
];

/**
 * Narrow an arbitrary parsed body to the error shape.
 *
 * Takes `unknown` because that is what `response.json()` honestly is: it may be
 * a success payload, an error payload, HTML, or null. Anything that does not
 * carry an `error` object contributes nothing to classification.
 */
function readError(body: unknown): GeminiErrorBody['error'] | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return undefined;
  return err as GeminiErrorBody['error'];
}

function haystack(err: GeminiErrorBody['error'] | undefined): string {
  if (!err) return '';
  return `${err.message ?? ''} ${err.status ?? ''}`.toLowerCase();
}

/**
 * Classify an HTTP response from the Gemini API.
 *
 * @param status HTTP status code.
 * @param body   Parsed JSON body of any shape, or null when absent/unparseable.
 */
export function classifyGeminiResponse(status: number, body: unknown): FailureReason | 'ok' {
  if (status >= 200 && status < 300) return 'ok';

  const err = readError(body);
  const text = haystack(err);
  const apiStatus = (err?.status ?? '').toUpperCase();

  // Quota first: a 429 is unambiguous, and RESOURCE_EXHAUSTED can arrive on
  // other codes. Checked before the key hints because a quota message can
  // mention "API key" incidentally ("quota for this API key").
  if (status === 429) return 'quota';
  if (apiStatus === 'RESOURCE_EXHAUSTED') return 'quota';
  if (QUOTA_HINTS.some((h) => text.includes(h))) return 'quota';

  // Bad credential. 400 only counts when the body says it is about the key.
  if (KEY_HINTS.some((h) => text.includes(h))) return 'invalid_key';
  if (status === 401) return 'invalid_key';
  // 403 is PERMISSION_DENIED: a disabled key or an API not enabled on the
  // project. From the user's point of view the fix is the same — the key is
  // not usable — so it maps to invalid_key rather than a fifth category.
  if (status === 403) return 'invalid_key';

  // Server-side faults and anything unrecognised.
  return 'unknown';
}

/**
 * Is this failure worth retrying, rather than surfacing to the user?
 *
 * 429 is the obvious one. **503 UNAVAILABLE matters just as much**: a free-tier
 * Flash model returns "This model is currently experiencing high demand" under
 * load, and treating that as a hard failure kills an entire generation run over
 * a wobble that clears in seconds. Observed live on 2026-09-03, where it took
 * 80 seconds to return 503 and aborted the whole set.
 *
 * 500 and 504 are included on the same reasoning: transient server-side faults,
 * safe to repeat because generation is idempotent per section.
 */
export function isRetryableStatus(status: number, body: unknown): boolean {
  if (status === 429) return true;
  if (status === 500 || status === 503 || status === 504) return true;

  const apiStatus = (readError(body)?.status ?? '').toUpperCase();
  return apiStatus === 'UNAVAILABLE' || apiStatus === 'RESOURCE_EXHAUSTED';
}

/**
 * Classify a thrown error from fetch (no HTTP response arrived at all).
 *
 * The browser gives almost nothing here: an opaque TypeError. Anything that
 * reached us without a status is a transport problem.
 */
export function classifyThrownError(err: unknown): FailureReason {
  if (err instanceof Error && err.name === 'AbortError') return 'network';
  return 'network';
}

/** Short, non-technical sentence for a failure. Never leaks a key or a raw API message. */
export function reasonToMessage(reason: FailureReason): string {
  switch (reason) {
    case 'invalid_key':
      return "That key didn't work. Check you copied all of it, then try again.";
    case 'quota':
      return 'Gemini is busy right now — try again in a minute.';
    case 'network':
      return "Couldn't reach Google. Check your connection and try again.";
    case 'unknown':
      return 'Something went wrong on Google’s end. Try again in a moment.';
  }
}
