import { supabase } from './supabase';
import { isValidAvatarValue, parseAvatar, photoPath, photoValue } from '../core/avatar';

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
  /**
   * The profile picture: NULL (a default face), 'face:N' or 'photo:<path>'.
   * See `src/core/avatar.ts` for what each means (migration 0016).
   */
  avatar: string | null;
  created_at: string;
}

const COLUMNS = 'id, display_name, gemini_api_key, pet, avatar, created_at';
const COLUMNS_BEFORE_0016 = 'id, display_name, gemini_api_key, pet, created_at';
const COLUMNS_BEFORE_0011 = 'id, display_name, gemini_api_key, created_at';

/** Postgres: column does not exist. */
const UNDEFINED_COLUMN = '42703';

/** A profile picture was chosen before the database could store one. */
export class AvatarsUnavailableError extends Error {
  constructor() {
    super('Profile pictures are not switched on yet.');
    this.name = 'AvatarsUnavailableError';
  }
}

/**
 * Fetch the signed-in user's profile, creating it if the trigger has not yet.
 *
 * ## Why this retries instead of just selecting the columns
 *
 * `fetchProfile` is not a screen's private query — Settings, the quiz's
 * grading, the assistant and the flashcard variant pass all read the API key
 * through it, and it throws on error. Naming a column that does not exist yet
 * would therefore not "break the avatar": it would break marking written
 * answers and making cards, everywhere, until the migration was applied.
 *
 * That is the failure §12 flagged for 0009 and §10 for 0007 — a build that
 * SELECTs a column the database has not got. So this asks for everything and,
 * on exactly the "no such column" error, steps back one migration at a time:
 * without `avatar` (0016), then without `pet` (0011). One query in the normal
 * case; more only while a migration is outstanding.
 */
export async function fetchProfile(): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select(COLUMNS).maybeSingle();
  if (!error) return data as Profile | null;
  if (error.code !== UNDEFINED_COLUMN) throw new Error(error.message);

  const before0016 = await supabase.from('profiles').select(COLUMNS_BEFORE_0016).maybeSingle();
  if (!before0016.error) {
    console.warn(
      '[profile] no "avatar" column — everyone gets a default face. ' +
        'Apply supabase/migrations/0016_profile_pictures_and_nomi_chats.sql to allow choosing.',
    );
    return before0016.data ? { ...(before0016.data as Omit<Profile, 'avatar'>), avatar: null } : null;
  }
  if (before0016.error.code !== UNDEFINED_COLUMN) throw new Error(before0016.error.message);

  console.warn(
    '[profile] no "pet" column — everyone gets the default pet. ' +
      'Apply supabase/migrations/0011_pet_choice.sql to let people choose.',
  );
  const fallback = await supabase.from('profiles').select(COLUMNS_BEFORE_0011).maybeSingle();
  if (fallback.error) throw new Error(fallback.error.message);
  return fallback.data ? { ...fallback.data, pet: null, avatar: null } : null;
}

async function currentUserId(): Promise<string> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw new Error(userError.message);
  const id = userData.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

/**
 * Remember which pet the student picked.
 *
 * Upserts the same way `saveGeminiKey` does, so it works on the first save for
 * an account whose profile row the trigger has not created yet.
 */
export async function savePetChoice(pet: string): Promise<void> {
  const id = await currentUserId();
  const { error } = await supabase.from('profiles').upsert({ id, pet }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}

/** Store or replace the user's Gemini key. Pass null to remove it. */
export async function saveGeminiKey(key: string | null): Promise<void> {
  const id = await currentUserId();
  const { error } = await supabase
    .from('profiles')
    .upsert({ id, gemini_api_key: key }, { onConflict: 'id' });

  if (error) throw new Error(error.message);
}

/**
 * The name Home greets them by. Trimmed; empty clears it.
 *
 * `display_name` has existed since 0001 and nothing ever set it, which is why
 * Home could not say "Welcome back, Sarah" (NOTES §36).
 */
export async function saveDisplayName(name: string): Promise<void> {
  const id = await currentUserId();
  const clean = name.trim().slice(0, 60);
  const { error } = await supabase
    .from('profiles')
    .upsert({ id, display_name: clean.length > 0 ? clean : null }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}

/** Choose a built-in face, or clear the choice with null. */
export async function saveAvatar(value: string | null): Promise<void> {
  if (!isValidAvatarValue(value)) throw new Error(`Not a profile picture: ${value}`);
  const id = await currentUserId();
  const { error } = await supabase.from('profiles').upsert({ id, avatar: value }, { onConflict: 'id' });
  if (error?.code === UNDEFINED_COLUMN) throw new AvatarsUnavailableError();
  if (error) throw new Error(error.message);
}

/**
 * Upload a profile photo and make it the picture.
 *
 * The caller hands over an already-resized image (`src/ui/avatar.tsx` draws it
 * to 256px first). Order matters: upload, then point the profile at it, then
 * remove the previous photo — so a failure part-way leaves either the old
 * picture or the new one showing, never a profile pointing at nothing.
 */
export async function uploadAvatarPhoto(image: Blob, previous: string | null): Promise<string> {
  const id = await currentUserId();
  const path = photoPath(id, Date.now());

  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, image, { contentType: 'image/jpeg', upsert: false });
  if (uploadError) {
    if (/bucket not found/i.test(uploadError.message)) throw new AvatarsUnavailableError();
    throw new Error(uploadError.message);
  }

  const value = photoValue(path);
  await saveAvatar(value);

  const old = previous ? parseAvatar(previous, id) : null;
  if (old?.kind === 'photo' && old.path !== path) {
    // Best effort. An orphaned 30 KB picture is not worth failing a save over.
    const { error } = await supabase.storage.from('avatars').remove([old.path]);
    if (error) console.warn(`[profile] could not remove the old picture: ${error.message}`);
  }
  return value;
}

/** A short-lived link to a profile photo. The bucket is private. */
export async function avatarPhotoUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from('avatars').createSignedUrl(path, 60 * 60);
  if (error || !data) return null;
  return data.signedUrl;
}

/** Every photo this user has uploaded — for Delete my data. Best effort. */
export async function removeAvatarPhotos(): Promise<void> {
  const id = await currentUserId();
  const { data, error } = await supabase.storage.from('avatars').list(id);
  if (error || !data || data.length === 0) return;
  await supabase.storage.from('avatars').remove(data.map((f) => `${id}/${f.name}`));
}
