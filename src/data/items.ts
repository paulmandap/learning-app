import { completeRows, supabase } from './supabase';
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
  /**
   * A rephrasing written after the card was failed three times (Phase 8).
   * Null until then. The screens ask for `promptFor(item)`, never this directly.
   */
  variant_prompt: string | null;
  /**
   * D7's second pass over Apply-tier rubrics. Null = not checked.
   *
   * Deliberately NOT `excerpt_verified`, whose meaning §4 fixes exactly.
   */
  rubric_verified: boolean | null;
}

const COLUMNS =
  // `form` is gone from this list. It was written on every insert and read by
  // nothing — measured 2026-09-12: null on every card in the database, because
  // the generation schema stopped returning it. See migration 0015, which drops
  // the column. Selecting fewer columns is safe whether or not that has run.
  'id, study_set_id, document_id, page_index, section_title, kind, level, prompt, answer, ' +
  'options, rubric, source_excerpt, excerpt_verified, check_flag, topic, hidden, created_at, ' +
  'variant_prompt, rubric_verified';

/**
 * The question to put in front of the student.
 *
 * One place, so a screen cannot show the original of a card that has been
 * rephrased. Everything that COMPARES prompts — dedup, the drop log — keeps
 * using `prompt`, which is why the variant is a separate column rather than an
 * overwrite.
 */
export function promptFor(item: Pick<StudyItem, 'prompt' | 'variant_prompt'>): string {
  return item.variant_prompt?.trim() || item.prompt;
}

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
    // count: the deck is the clearest case where a truncated read is a wrong
    // answer rather than a slow one — it deals fewer cards than the student
    // has and nothing can tell.
    .select(COLUMNS, { count: 'exact' })
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

  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return completeRows('listItems', result) as unknown as StudyItem[];
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
  const { data, error, count } = await supabase
    .from('study_items')
    // count: a short read here does not look broken, it silently WEAKENS
    // dedup — prompts it never saw cannot be compared against, so generation
    // writes duplicates of cards that already exist.
    .select('prompt', { count: 'exact' })
    .eq('study_set_id', studySetId);

  if (error) throw new Error(error.message);
  return completeRows('existingPrompts', { data, count }).map(
    (r: { prompt: string }) => r.prompt,
  );
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

/** One card, by id. Used by the rephrase pass, which starts from an attempt. */
export async function getItem(itemId: string): Promise<StudyItem | null> {
  const { data, error } = await supabase
    .from('study_items')
    .select(COLUMNS)
    .eq('id', itemId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data ?? null) as unknown as StudyItem | null;
}

/** Store a rephrasing. The original `prompt` is deliberately left in place. */
export async function saveVariantPrompt(itemId: string, prompt: string): Promise<void> {
  const { error } = await supabase
    .from('study_items')
    .update({ variant_prompt: prompt })
    .eq('id', itemId);
  if (error) throw new Error(error.message);
}

/** Record D7's second-pass verdict on one Apply-tier rubric. */
export async function saveRubricVerdict(itemId: string, verified: boolean): Promise<void> {
  const { error } = await supabase
    .from('study_items')
    .update({ rubric_verified: verified })
    .eq('id', itemId);
  if (error) throw new Error(error.message);
}

/**
 * Apply-tier written answers whose rubric has not been checked yet.
 *
 * Filtered in SQL rather than in the client so a large set does not have to be
 * pulled down to find the two or three items that need a second opinion. The
 * partial index in 0007 covers exactly this predicate.
 */
export async function itemsNeedingRubricCheck(studySetId: string): Promise<StudyItem[]> {
  const { data, error } = await supabase
    .from('study_items')
    .select(COLUMNS)
    .eq('study_set_id', studySetId)
    .eq('hidden', false)
    .eq('kind', 'short_answer')
    .eq('level', 'apply')
    .is('rubric_verified', null);

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as StudyItem[];
}
