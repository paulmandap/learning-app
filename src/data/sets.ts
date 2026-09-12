import { supabase, type Db } from './supabase';
import type { Plan } from '../core/planner';
import type { DropSummary } from '../core/validate';

/**
 * Study sets. RLS scopes every query to the signed-in user, so nothing here
 * filters by user_id in client code — the database decides.
 */

export type SetStatus = 'empty' | 'generating' | 'ready' | 'failed';

export interface StudySet {
  id: string;
  title: string;
  status: SetStatus;
  plan: StoredPlan | null;
  created_at: string;
  updated_at: string;
  /** Only populated by listSets, which asks for it. Undefined elsewhere. */
  cardCount?: number;
}

/**
 * The plan, plus which sections have already been generated.
 *
 * Persisting completion per section is what makes a refresh mid-generation
 * resume instead of restarting — a Phase 2 acceptance criterion, and the
 * difference between a dropped connection costing 10 seconds or 2 minutes.
 */
export interface StoredPlan extends Plan {
  completedSectionIds: string[];
  requestedCount: number;
  /** Why cards were left out, so "19 of 20" is explainable rather than a mystery. */
  droppedSummary?: DropSummary;
}

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

/**
 * Every set, newest activity first, each with how many cards it holds.
 *
 * The count comes back as an embedded aggregate rather than a query per set, so
 * a list of twenty sets is still one round trip. `hidden` cards are excluded to
 * match what the study screens actually show — a reported card should not still
 * be counted on the home screen.
 */
export async function listSets(db: Db = supabase): Promise<StudySet[]> {
  const { data, error } = await db
    .from('study_sets')
    .select('id, title, status, plan, created_at, updated_at, study_items(count)')
    .eq('study_items.hidden', false)
    .order('updated_at', { ascending: false });

  if (error) throw new Error(error.message);

  type Row = Omit<StudySet, 'cardCount'> & { study_items?: { count: number }[] };
  return ((data ?? []) as Row[]).map(({ study_items, ...set }) => ({
    ...set,
    cardCount: study_items?.[0]?.count ?? 0,
  }));
}

export async function getSet(id: string): Promise<StudySet | null> {
  const { data, error } = await supabase
    .from('study_sets')
    .select('id, title, status, plan, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as StudySet | null) ?? null;
}

export async function createSet(title: string): Promise<StudySet> {
  const user_id = await currentUserId();
  const { data, error } = await supabase
    .from('study_sets')
    .insert({ user_id, title: title.trim() || 'My notes', status: 'empty' })
    .select('id, title, status, plan, created_at, updated_at')
    .single();

  if (error) throw new Error(error.message);
  return data as StudySet;
}

export async function updateSet(
  id: string,
  patch: { status?: SetStatus; plan?: StoredPlan; title?: string },
): Promise<void> {
  const { error } = await supabase
    .from('study_sets')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(error.message);
}

/** Mark one section generated, so a resumed run skips it. */
export async function markSectionComplete(setId: string, sectionId: string): Promise<void> {
  const set = await getSet(setId);
  if (!set?.plan) return;

  const done = new Set(set.plan.completedSectionIds ?? []);
  done.add(sectionId);
  await updateSet(setId, { plan: { ...set.plan, completedSectionIds: [...done] } });
}

/** Delete a set. Storage objects are removed first; rows cascade. */
export async function deleteSet(id: string): Promise<void> {
  const { data: docs } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('study_set_id', id);

  const paths = (docs ?? [])
    .map((d: { storage_path: string | null }) => d.storage_path)
    .filter((p): p is string => !!p);

  if (paths.length > 0) {
    await supabase.storage.from('documents').remove(paths);
  }

  const { error } = await supabase.from('study_sets').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * "Delete my data" (spec §4).
 *
 * Loops the user's sets, removing storage objects first and then the rows —
 * database cascades handle documents, pages, items and attempts. The profile
 * row (and the stored Gemini key) is cleared last.
 *
 * Full account deletion needs the service role and stays a manual operation;
 * this removes everything the app itself can reach.
 */
export async function deleteAllMyData(): Promise<{ setsDeleted: number }> {
  const sets = await listSets();
  for (const set of sets) {
    await deleteSet(set.id);
  }

  const id = await currentUserId();
  const { error } = await supabase
    .from('profiles')
    .update({ gemini_api_key: null, display_name: null })
    .eq('id', id);
  if (error) throw new Error(error.message);

  return { setsDeleted: sets.length };
}
