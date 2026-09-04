/**
 * The provider boundary from spec §3.1.
 *
 * Today the only implementation is GeminiBrowserProvider, which calls Gemini
 * from the browser with the user's own key (D12). The interface exists so a
 * future EdgeFunctionProvider could take over with no UI change — that is a
 * later-phase concern and must not be built now.
 *
 * Phase 1 implements testConnection() only. The remaining members are declared
 * so the shape is fixed, and throw NotImplementedInPhase1 if called.
 */

import type { FailureReason } from '../core/ai-errors';

export type TestConnectionResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: FailureReason };

// --- Types for later phases. Declared, not implemented. -------------------

export interface ReadResultPage {
  page_index: number;
  headings: string[];
  blocks: { type: 'paragraph' | 'list' | 'table' | 'figure'; text: string }[];
  readability: number;
}

export interface ReadResult {
  pages: ReadResultPage[];
}

export interface GenerateInput {
  sectionText: string;
  sectionTitle: string;
  budget: { remember: number; understand: number; apply: number };
  pageRange: { from: number; to: number };
}

export interface GeneratedItem {
  kind: 'flashcard' | 'mcq' | 'short_answer';
  level: 'remember' | 'understand' | 'apply';
  form?: string;
  prompt: string;
  answer: string;
  options?: { text: string; correct: boolean }[];
  rubric?: { expected_concepts: { id: string; text: string }[]; model_answer: string };
  /**
   * Citation by index. The model does NOT return source text — the app resolves
   * the real sentence from its own stored notes, so what the user is shown
   * cannot be a model fabrication.
   */
  page_index: number;
  source_sentence: number;
  topic?: string;
  check_flag?: string;
}

export interface Rubric {
  expected_concepts: { id: string; text: string }[];
  model_answer: string;
}

export interface GradeResult {
  concepts_hit: string[];
  feedback: string;
}

export class NotImplementedInPhase1 extends Error {
  constructor(member: string) {
    super(`${member} is a later-phase feature and is not implemented in Phase 1.`);
    this.name = 'NotImplementedInPhase1';
  }
}

export interface AIProvider {
  testConnection(): Promise<TestConnectionResult>;
  readDocument(input: { file: Blob; mime: string } | { text: string }): Promise<ReadResult>;
  generateItems(input: GenerateInput): Promise<GeneratedItem[]>;
  gradeAnswer(input: { prompt: string; rubric: Rubric; answer: string }): Promise<GradeResult>;
}
