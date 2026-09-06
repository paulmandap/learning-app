import { supabase } from './supabase';

/**
 * The user's own profile row. RLS restricts every one of these calls to the
 * signed-in user, so no query here filters by id in client code — the database
 * does it. That is deliberate: client-side filtering is not authorisation.
 */

export interface Profile {
  id: string;
  display_name: string | null;
  gemini_api_key: string | null;
  /** Which pet was chosen. NULL means "has not chosen"; the app defaults it. */
  pet: string | null;
  created_at: string;
}

const COLUMNS = 'id, display_name, gemini_api_key, pet, created_at';
const COLUMNS_BEFORE_0011 = 'id, display_name, gemini_api_key, created_at';

/** Postgres: column does not exist. */
const UNDEFINED_COLUMN = '42703';

/**
 * Fetch the signed-in user's profile, creating it if the trigger has not yet.
 *
 * ## Why this retries instead of just selecting the column
 *
 * `fetchProfile` is not a screen's private query — Settings, the quiz's
 * grading, the assistant and the flashcard variant pass all read the API key
 * through it, and it throws on error. Naming a column that does not exist yet
 * would therefore not "break the pet": it would break marking written answers
 * and making cards, everywhere, until `0011_pet_choice.sql` was applied.
 *
 * That is the failure §12 flagged for 0009 and §10 for 0007 — a build that
 * SELECTs a column the database has not got. Rather than making the deploy
 * order matter again, this asks for `pet` and, on exactly the "no such column"
 * error, asks again without it. One query in the normal case; a second only
 * while the migration is outstanding. Same shape as `recordAttempt` catching
 * the check violation for 0006 (§9.6).
 */
export async function fetchProfile(): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select(COLUMNS).maybeSingle();
  if (!error) return data as Profile | null;

  if (error.code !== UNDEFINED_COLUMN) throw new Error(error.message);

  console.warn(
    '[profile] no "pet" column — everyone gets the default pet. ' +
      'Apply supabase/migrations/0011_pet_choice.sql to let people choose.',
  );
  const fallback = await supabase.from('profiles').select(COLUMNS_BEFORE_0011).maybeSingle();
  if (fallback.error) throw new Error(fallback.error.message);
  return fallback.data ? { ...fallback.data, pet: null } : null;
}

/**
 * Remember which pet the student picked.
 *
 * Upserts the same way `saveGeminiKey` does, so it works on the first save for
 * an account whose profile row the trigger has not created yet.
 */
export async function savePetChoice(pet: string): Promise<void> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw new Error(userError.message);
  const id = userData.user?.id;
  if (!id) throw new Error('Not signed in.');

  const { error } = await supabase.from('profiles').upsert({ id, pet }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}

/** Store or replace the user's Gemini key. Pass null to remove it. */
export async function saveGeminiKey(key: string | null): Promise<void> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw new Error(userError.message);
  const id = userData.user?.id;
  if (!id) throw new Error('Not signed in.');

  const { error } = await supabase
    .from('profiles')
    .upsert({ id, gemini_api_key: key }, { onConflict: 'id' });

  if (error) throw new Error(error.message);
}
