/**
 * Zod schemas for what the model returns, plus the JSON schemas we ask it for.
 *
 * Two jobs, deliberately separated:
 *  - `responseSchema` tells Gemini the shape to emit (structured output).
 *  - The Zod schemas verify it actually did. Structured output is a strong hint,
 *    not a guarantee, so nothing reaches the validators unparsed.
 *
 * Malformed ITEMS are dropped individually; a malformed BATCH is not fatal
 * either, because `parseItemsLoose` salvages the well-formed entries.
 */

import { z } from 'zod';

// ------------------------------------------------------------------ read --

export const blockSchema = z.object({
  type: z.enum(['paragraph', 'list', 'table', 'figure']),
  text: z.string(),
});

export const pageSchema = z.object({
  page_index: z.number().int().min(0),
  headings: z.array(z.string()).default([]),
  blocks: z.array(blockSchema).default([]),
  readability: z.number().min(0).max(1),
});

export const readResultSchema = z.object({
  pages: z.array(pageSchema),
});

export type ParsedReadResult = z.infer<typeof readResultSchema>;

/** Shape requested from Gemini for document reading (spec §3.2.1). */
export const READ_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          page_index: { type: 'integer' },
          headings: { type: 'array', items: { type: 'string' } },
          blocks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['paragraph', 'list', 'table', 'figure'] },
                text: { type: 'string' },
              },
              required: ['type', 'text'],
            },
          },
          readability: { type: 'number' },
        },
        required: ['page_index', 'headings', 'blocks', 'readability'],
      },
    },
  },
  required: ['pages'],
} as const;

// -------------------------------------------------------------- generate --

export const optionSchema = z.object({
  text: z.string().min(1),
  correct: z.boolean(),
});

export const rubricSchema = z.object({
  expected_concepts: z.array(z.object({ id: z.string(), text: z.string() })),
  model_answer: z.string(),
});

export const generatedItemSchema = z.object({
  kind: z.enum(['flashcard', 'mcq', 'short_answer']),
  level: z.enum(['remember', 'understand', 'apply']),
  form: z.string().optional(),
  prompt: z.string().min(1),
  answer: z.string().min(1),
  options: z.array(optionSchema).optional(),
  rubric: rubricSchema.optional(),
  /**
   * A compact SOURCE REFERENCE, not reproduced text.
   *
   * The model names the page and the 0-based sentence index its answer came
   * from; the app resolves the actual sentence from its own stored page text.
   * That is both faster (the largest single field no longer has to be written
   * out) and better grounded — what the user sees is provably their own note,
   * not a model paraphrase that happened to clear a similarity threshold.
   */
  page_index: z.number().int().min(0),
  source_sentence: z.number().int().min(0),
  topic: z.string().optional(),
  check_flag: z.string().optional(),
});

export const generateResultSchema = z.object({
  items: z.array(generatedItemSchema),
});

export type ParsedItem = z.infer<typeof generatedItemSchema>;

/**
 * Shape requested from Gemini for item generation (spec §3.2.3).
 *
 * Deliberately lean. Generation is entirely OUTPUT-bound — measured at ~330
 * input tokens against ~2,000-4,000 output tokens — so every field the model
 * has to write costs wall-clock time directly.
 *
 * Removed from the request:
 *  - `source_excerpt`: the single largest field, and pure duplication. The app
 *    already stores the page text, so the model now returns `source_sentence`
 *    (an index) and the app resolves the real sentence itself.
 *  - `form`: never read by any screen or validator.
 *
 * `rubric` is kept in the schema but the prompt asks for it on `short_answer`
 * items ONLY, where Phase 3 grading actually consumes it. Emitting expected
 * concepts plus a model answer for every flashcard was a large share of the
 * output for data nothing read.
 */
export const GENERATE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['flashcard', 'mcq', 'short_answer'] },
          level: { type: 'string', enum: ['remember', 'understand', 'apply'] },
          prompt: { type: 'string' },
          answer: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                correct: { type: 'boolean' },
              },
              required: ['text', 'correct'],
            },
          },
          rubric: {
            type: 'object',
            properties: {
              expected_concepts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { id: { type: 'string' }, text: { type: 'string' } },
                  required: ['id', 'text'],
                },
              },
              model_answer: { type: 'string' },
            },
            required: ['expected_concepts', 'model_answer'],
          },
          page_index: { type: 'integer' },
          source_sentence: { type: 'integer' },
          topic: { type: 'string' },
          check_flag: { type: 'string' },
        },
        required: ['kind', 'level', 'prompt', 'answer', 'page_index', 'source_sentence'],
      },
    },
  },
  required: ['items'],
} as const;

/**
 * Parse a generation payload, keeping whatever is well-formed.
 *
 * "Drop malformed items, never the whole batch" (§3.2.4): if the model emits
 * seven good items and one with a missing field, we keep seven. Discarding the
 * batch would waste a paid call and leave the section empty for no good reason.
 */
export function parseItemsLoose(payload: unknown): {
  items: ParsedItem[];
  malformed: number;
} {
  const container =
    typeof payload === 'object' && payload !== null && 'items' in payload
      ? (payload as { items: unknown }).items
      : payload;

  if (!Array.isArray(container)) return { items: [], malformed: 0 };

  const items: ParsedItem[] = [];
  let malformed = 0;

  for (const raw of container) {
    const parsed = generatedItemSchema.safeParse(raw);
    if (parsed.success) items.push(parsed.data);
    else malformed++;
  }

  return { items, malformed };
}

/** Parse a read payload. Returns null when it is unusable as a whole. */
export function parseReadResult(payload: unknown): ParsedReadResult | null {
  const direct = readResultSchema.safeParse(payload);
  if (direct.success) return direct.data;

  // Salvage: keep the pages that parse, drop the ones that do not. A single
  // unreadable page should not lose a 40-page document.
  if (typeof payload === 'object' && payload !== null && 'pages' in payload) {
    const pages = (payload as { pages: unknown }).pages;
    if (Array.isArray(pages)) {
      const good = pages
        .map((p) => pageSchema.safeParse(p))
        .filter((r): r is { success: true; data: z.infer<typeof pageSchema> } => r.success)
        .map((r) => r.data);
      if (good.length > 0) return { pages: good };
    }
  }
  return null;
}

// ----------------------------------------------------------------- grade --

export const gradeResultSchema = z.object({
  concepts_hit: z.array(z.string()).default([]),
  feedback: z.string().default(''),
});

/**
 * Shape requested from Gemini when grading a written answer (spec §3.2.5).
 *
 * Deliberately tiny. The model's only job is to say WHICH expected concepts the
 * answer covered; the score, the thresholds and the verdict are computed in
 * src/core/grade.ts so a model cannot mark itself generously.
 *
 * No reasoning field: the spec forbids storing or showing chain-of-thought, and
 * asking for it would cost output tokens for something we would discard.
 */
export const GRADE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    concepts_hit: { type: 'array', items: { type: 'string' } },
    feedback: { type: 'string' },
  },
  required: ['concepts_hit', 'feedback'],
} as const;

/** Parse a grade payload, defaulting to "nothing found" rather than throwing. */
export function parseGradeResult(payload: unknown): { concepts_hit: string[]; feedback: string } {
  const parsed = gradeResultSchema.safeParse(payload);
  if (parsed.success) return parsed.data;
  return { concepts_hit: [], feedback: '' };
}
