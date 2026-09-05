import { supabase } from './supabase';
import type { Level } from '../core/planner';
import type { ValidatedItem } from '../core/validate';

/**
 * Study items.
 *
 * Only validated items reach this module: every row inserted here has already
 * had its excerpt matched against the stored page text, so excerpt_verified is
 * true by construction. That flag means the quote was found in the notes — not
 * that the item is factually correct, human-checked, or second-model verified.
 */

export interface StudyItem {
  id: string;
  study_set_id: string;
  document_id: string | null;
  page_index: number | null;
  section_title: string | null;
  kind: 'flashcard' | 'mcq' | 'short_answer';
  level: Level;
  form: string | null;
  prompt: string;
  answer: string;
  options: { text: string; correct: boolean }[] | null;
  rubric: { expected_concepts: { id: string; text: string }[]; model_answer: string } | null;
  source_excerpt: string;
  excerpt_verified: boolean;
  check_flag: string | null;
  topic: string | null;
  hidden: boolean;
  created_at: string;
}

const COLUMNS =
  'id, study_set_id, document_id, page_index, section_title, kind, level, form, prompt, answer, ' +
  'options, rubric, source_excerpt, excerpt_verified, check_flag, topic, hidden, created_at';

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

/**
 * Insert one section's validated items.
 *
 * Called per section rather than once at the end, so cards become visible as
 * sections finish instead of everything appearing at once after two minutes.
 */
export async function insertItems(
  studySetId: string,
  documentIdByPage: Map<number, string>,
  sectionTitle: string,
  items: ValidatedItem[],
): Promise<number> {
  if (items.length === 0) return 0;
  const user_id = await currentUserId();

  const rows = items.map((item) => ({
    user_id,
    study_set_id: studySetId,
    document_id: documentIdByPage.get(item.page_index) ?? null,
    page_index: item.page_index,
    section_title: sectionTitle,
    kind: item.kind,
    level: item.level,
    form: item.form ?? null,
    prompt: item.prompt,
    answer: item.answer,
    options: item.options ?? null,
    rubric: item.rubric ?? null,
    source_excerpt: item.source_excerpt,
    excerpt_verified: true,
    check_flag: item.check_flag ?? null,
    topic: item.topic ?? null,
  }));

  const { error } = await supabase.from('study_items').insert(rows);
  if (error) throw new Error(error.message);
  return rows.length;
}

export async function listItems(
  studySetId: string,
  options: { level?: Level } = {},
): Promise<StudyItem[]> {
  let query = supabase
    .from('study_items')
    .select(COLUMNS)
    .eq('study_set_id', studySetId)
    .eq('hidden', false)
    .order('created_at', { ascending: true });

  // Levels are EXCLUSIVE. Understand means understand, not "understand and
  // everything easier".
  //
  // This reverses D2, deliberately and at the owner's request. D2 made each
  // level cumulative so that "choosing Apply never means only the hard ones" —
  // but the effect in practice was that Understand was mostly Remember. With
  // the 50/30/20 mix a 20-card set put 10 recall cards in front of 6 genuine
  // understand ones, so the level that was supposed to raise the difficulty
  // barely changed it. The owner's words: "5 cards in understand is basically
  // remember — there's no challenge at all."
  //
  // The cost of the reversal is that Apply is the smallest tier (20%), so on a
  // small set it can be nearly empty. The level buttons now carry their counts
  // so that is visible before you pick one, rather than being discovered as an
  // empty deck.
  if (options.level) query = query.eq('level', options.level);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as StudyItem[];
}

export async function countItems(studySetId: string): Promise<number> {
  const { count, error } = await supabase
    .from('study_items')
    .select('id', { count: 'exact', head: true })
    .eq('study_set_id', studySetId)
    .eq('hidden', false);

  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Existing prompts, so dedup survives a resumed run across sections. */
export async function existingPrompts(studySetId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('study_items')
    .select('prompt')
    .eq('study_set_id', studySetId);

  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { prompt: string }) => r.prompt);
}

/**
 * Hide a card the user reported (spec §6, Phase 4).
 *
 * Soft-hidden rather than deleted: `hidden` keeps the row for the drop log and
 * for any later review of what people report, while every study query filters
 * on `hidden = false`, so a reported card never appears again.
 *
 * With five users, "Report this card" IS the second verification pass (D7).
 */
export async function reportItem(itemId: string): Promise<void> {
  const { error } = await supabase.from('study_items').update({ hidden: true }).eq('id', itemId);
  if (error) throw new Error(error.message);
}
