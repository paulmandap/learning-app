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
  created_at: string;
}

/** Fetch the signed-in user's profile, creating it if the trigger has not yet. */
export async function fetchProfile(): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, gemini_api_key, created_at')
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
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
