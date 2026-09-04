/**
 * GeminiBrowserProvider — calls Gemini directly from the browser with the
 * user's own key (D12, approved).
 *
 * Plain fetch, no SDK: the key is loaded from the user's profiles row at
 * runtime rather than from a build-time env var, which is the opposite of what
 * SDKs assume. A fetch wrapper is also trivially mockable, which the spec's
 * "tests pass with no network" requirement demands.
 *
 * Header discipline (Phase 0 CORS gate): the endpoint's preflight allows
 * exactly `x-goog-api-key`. Adding any other custom header risks a preflight
 * the endpoint will not answer. Send nothing else.
 */

import { GEMINI_API_BASE, MODELS } from './models';
import {
  classifyGeminiResponse,
  classifyThrownError,
  isRetryableStatus,
} from '../core/ai-errors';
import { parseRetryAfter, RateLimitedError } from '../core/queue';
import {
  ALLOWED_FORMS,
  buildGeneratePrompt,
  buildGradePrompt,
  READ_SYSTEM_PROMPT,
} from './prompts';
import {
  GENERATE_RESPONSE_SCHEMA,
  GRADE_RESPONSE_SCHEMA,
  parseGradeResult,
  parseItemsLoose,
  parseReadResult,
  READ_RESPONSE_SCHEMA,
} from './schemas';
import {
  type AIProvider,
  type GenerateInput,
  type GeneratedItem,
  type GradeResult,
  type ReadResult,
  type Rubric,
  type TestConnectionResult,
} from './provider';

/** Inline requests total 100 MB; PDFs are capped at 50 MB (verified 2026-09-03). */
export const MAX_INLINE_BYTES = 15 * 1024 * 1024;

export class GeminiCallError extends Error {
  constructor(
    message: string,
    public readonly reason: 'invalid_key' | 'quota' | 'network' | 'unknown',
  ) {
    super(message);
    this.name = 'GeminiCallError';
  }
}

/** Milliseconds before a connection test is abandoned. */
const TEST_TIMEOUT_MS = 15_000;

/**
 * Deadline for a generate/read call.
 *
 * Generous, because reading a real PDF legitimately takes tens of seconds — but
 * finite, because an overloaded model was observed sitting for 80 seconds
 * before finally returning 503. Without a deadline a single wedged call stalls
 * the entire set.
 */
const CALL_TIMEOUT_MS = 100_000;

export class GeminiBrowserProvider implements AIProvider {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(
    apiKey: string,
    options: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
  ) {
    this.#apiKey = apiKey;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#base = options.baseUrl ?? GEMINI_API_BASE;
  }

  /**
   * Doubles as "Test connection" in Settings and as the Phase 1 CORS gate.
   *
   * models.list is the cheapest authenticated call available: it costs no
   * tokens, needs no request body, and confirms in one round trip that the
   * key is valid, that quota remains, and that the browser can reach Google
   * cross-origin at all.
   */
  async testConnection(): Promise<TestConnectionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}/models?pageSize=200`, {
        method: 'GET',
        headers: { 'x-goog-api-key': this.#apiKey },
        signal: controller.signal,
      });
    } catch (err) {
      return { ok: false, reason: classifyThrownError(err) };
    } finally {
      clearTimeout(timer);
    }

    // Parse defensively: an error response may not be JSON at all.
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const verdict = classifyGeminiResponse(response.status, body);
    if (verdict !== 'ok') {
      return { ok: false, reason: verdict };
    }

    const models = extractModelNames(body);
    return { ok: true, models };
  }

  /**
   * Read a document into page-anchored structured text (§3.2.1).
   *
   * Pasted text becomes a single page with no model call at all: it is already
   * text, and sending it to Gemini would spend a request from a small daily
   * budget to learn nothing.
   */
  async readDocument(
    input: { file: Blob; mime: string } | { text: string },
  ): Promise<ReadResult> {
    if ('text' in input) {
      // ONE page, deliberately.
      //
      // Splitting a paste into ~400-word pages was tried and MEASURED: because
      // the planner sections by page, a 1,885-word note became 10 sections and
      // therefore 10 requests, and wall-clock went from 11.8s to 75.3s. Each
      // request carries a large fixed cost (~5-9s) plus the pacing gap, so more
      // requests is strictly worse than one larger one at this size.
      //
      // See paginateText below if a document ever grows big enough that a
      // single request stops being viable.
      return {
        pages: [
          {
            page_index: 0,
            headings: extractHeadings(input.text),
            blocks: input.text
              .split(/\n{2,}/)
              .map((t) => t.trim())
              .filter((t) => t.length > 0)
              .map((text) => ({ type: 'paragraph' as const, text })),
            readability: 1,
          },
        ],
      };
    }

    if (input.file.size > MAX_INLINE_BYTES) {
      // The Files API is the documented route above the inline threshold, but
      // its upload flow is unverified from a browser and is Phase 2 work in its
      // own right. Failing loudly beats silently truncating a student's notes.
      throw new GeminiCallError(
        `File is too large to read in one go (${Math.round(input.file.size / 1024 / 1024)} MB).`,
        'unknown',
      );
    }

    const payload = await this.#generateContent(MODELS.light, {
      systemInstruction: { parts: [{ text: READ_SYSTEM_PROMPT }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: input.mime, data: await blobToBase64(input.file) } },
            { text: 'Transcribe every page of this document using the schema.' },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: READ_RESPONSE_SCHEMA,
        temperature: 0,
      },
    });

    const parsed = parseReadResult(payload);
    if (!parsed) {
      throw new GeminiCallError("We couldn't read that file.", 'unknown');
    }

    return {
      pages: parsed.pages.map((p) => ({
        page_index: p.page_index,
        headings: p.headings,
        blocks: p.blocks,
        readability: p.readability,
      })),
    };
  }

  /**
   * Write items for one section (§3.2.3). One call per section, by design:
   * it keeps each request small, and it makes generation resumable per section.
   */
  async generateItems(input: GenerateInput): Promise<GeneratedItem[]> {
    const prompt = buildGeneratePrompt({
      sectionTitle: input.sectionTitle,
      budget: input.budget,
      pagesText: input.sectionText,
      allowedForms: [...ALLOWED_FORMS],
    });

    const payload = await this.#generateContent(MODELS.light, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GENERATE_RESPONSE_SCHEMA,
        temperature: 0.4,
      },
    });

    // Malformed items are dropped here; the batch survives (§3.2.4).
    const { items } = parseItemsLoose(payload);
    return items as GeneratedItem[];
  }

  /**
   * POST generateContent and return the parsed JSON body of the first candidate.
   *
   * Throws RateLimitedError on 429 so CallQueue can apply backoff, and
   * GeminiCallError otherwise. Retry-After is read opportunistically — the
   * browser is not given it, so the queue's fixed ladder is the real mechanism.
   */
  async #generateContent(model: string, body: unknown): Promise<unknown> {
    // An overloaded model can sit for well over a minute before returning 503,
    // so a call without a deadline can stall a whole run indefinitely.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.#apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // A timeout is a transient condition, not a permanent failure — retry it
      // rather than losing the section.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new RateLimitedError(null);
      }
      throw new GeminiCallError('Network request failed.', classifyThrownError(err));
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    // Retryable BEFORE classification: a 503 "high demand" is a wobble to wait
    // out, and letting it fall through to 'unknown' aborts the whole run.
    if (!response.ok && isRetryableStatus(response.status, parsed)) {
      throw new RateLimitedError(parseRetryAfter(response.headers.get('Retry-After')));
    }

    const verdict = classifyGeminiResponse(response.status, parsed);
    if (verdict !== 'ok') {
      throw new GeminiCallError('Gemini rejected the request.', verdict);
    }

    return extractJsonPayload(parsed);
  }

  /**
   * Grade a written answer against its rubric (spec §3.2.5).
   *
   * The model reports only WHICH expected concepts it found, plus short
   * feedback. Scoring, thresholds and the verdict are computed deterministically
   * in src/core/grade.ts — a model must not be able to mark itself generously.
   *
   * Uses the light model (D11): matching an answer to a fixed checklist is what
   * makes a small model reliable here.
   */
  async gradeAnswer(input: {
    prompt: string;
    rubric: Rubric;
    answer: string;
  }): Promise<GradeResult> {
    const payload = await this.#generateContent(MODELS.light, {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: buildGradePrompt({
                question: input.prompt,
                expectedConcepts: input.rubric.expected_concepts,
                studentAnswer: input.answer,
              }),
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GRADE_RESPONSE_SCHEMA,
        // Marking should be repeatable: the same answer must not pass one
        // minute and fail the next.
        temperature: 0,
      },
    });

    const parsed = parseGradeResult(payload);
    return { concepts_hit: parsed.concepts_hit, feedback: parsed.feedback };
  }
}

/**
 * Pull the JSON object out of a generateContent response.
 *
 * With responseMimeType application/json the payload arrives as TEXT inside the
 * candidate part, so it needs a second parse. Models also sometimes wrap it in
 * a ```json fence despite being told to emit JSON, so that is stripped.
 */
export function extractJsonPayload(response: unknown): unknown {
  const parts = (
    response as { candidates?: { content?: { parts?: { text?: string }[] } }[] } | null
  )?.candidates?.[0]?.content?.parts;

  const text = parts?.map((p) => p.text ?? '').join('') ?? '';
  if (text.trim().length === 0) return null;

  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    return null;
  }
}

/** Base64 for inline request data, without Node Buffer (this runs in a browser). */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000; // chunked so a large file does not blow the call stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Target words per page when splitting pasted text. */
export const WORDS_PER_PAGE = 400;

/**
 * Break pasted text into pages on paragraph boundaries.
 *
 * Never splits mid-paragraph, so a sentence index always resolves against the
 * page that produced it. A short heading-like line immediately followed by
 * prose is kept with that prose and recorded as the page's heading, which is
 * what lets the planner name sections after the user's own headings.
 */
export function paginateText(text: string): ReadResult['pages'] {
  const blocks = text
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const pages: ReadResult['pages'] = [];
  let current: string[] = [];
  let words = 0;
  let heading: string | null = null;

  const flush = () => {
    if (current.length === 0) return;
    pages.push({
      page_index: pages.length,
      headings: heading ? [heading] : [],
      blocks: current.map((t) => ({ type: 'paragraph' as const, text: t })),
      readability: 1,
    });
    current = [];
    words = 0;
    heading = null;
  };

  for (const block of blocks) {
    const isHeading =
      /^#{1,6}\s+\S/.test(block) ||
      (!/[.!?]$/.test(block) && block.split(/\s+/).length <= 8 && !block.includes('\n'));

    // A heading starts a new page, so sections line up with the user's own
    // structure instead of falling on an arbitrary word count.
    if (isHeading && current.length > 0) flush();

    if (isHeading && heading === null) {
      heading = block.replace(/^#{1,6}\s+/, '');
    }

    current.push(block);
    words += block.split(/\s+/).length;
    if (words >= WORDS_PER_PAGE) flush();
  }
  flush();

  return pages.length > 0
    ? pages
    : [{ page_index: 0, headings: [], blocks: [{ type: 'paragraph', text }], readability: 1 }];
}

/** Markdown-ish headings from pasted text, used to prefill the set name. */
export function extractHeadings(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, ''));
}

/**
 * Pull usable model IDs out of a models.list payload.
 *
 * Filters to models that can actually generate content, so the Settings screen
 * cannot report success on a key that only sees embedding models.
 */
export function extractModelNames(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  return models
    .filter((m): m is { name: string; supportedGenerationMethods?: string[] } => {
      if (typeof m !== 'object' || m === null) return false;
      return typeof (m as { name?: unknown }).name === 'string';
    })
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
}
