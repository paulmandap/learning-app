/**
 * Can a profile picture be saved, and saved again?
 *
 *   npx tsx --env-file=.env scripts/avatar-probe.ts
 *
 * The owner's report (NOTES §37): the picture would not change, and Settings
 * said "Couldn't save that picture just now. Try again in a moment" however
 * long he waited. This runs the calls Settings makes — three faces, two photos,
 * a face after a photo — as TEST_USER_A, and prints the REAL error each time,
 * which Settings replaces with a sentence.
 *
 * Its first run found migration 0016 not applied, and a missing column reported
 * as PGRST204 that nothing recognised. After 0016 is applied every line should
 * say OK. Restores the account's picture and removes the photos it uploaded.
 *
 * Needs TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD.
 */
import { supabase } from '../src/data/supabase';
import { fetchProfile, saveAvatar, uploadAvatarPhoto } from '../src/data/profile';

// A valid 1x1 JPEG.
const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

const jpeg = () => new Blob([Buffer.from(JPEG_B64, 'base64')], { type: 'image/jpeg' });

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    const now = (await fetchProfile())?.avatar ?? null;
    console.log(`OK    ${name}${out ? ` -> ${String(out)}` : ''}   (stored: ${now})`);
  } catch (err) {
    console.log(`FAIL  ${name}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
}

async function main() {
  const { data: auth, error } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_A_EMAIL!,
    password: process.env.TEST_USER_A_PASSWORD!,
  });
  if (error) throw new Error(`sign-in: ${error.message}`);
  const uid = auth.user!.id;

  const original = (await fetchProfile())?.avatar ?? null;
  console.log('avatar before:', original);

  await step('face 2', () => saveAvatar('face:2'));
  await step('face 5', () => saveAvatar('face:5'));
  await step('face 9', () => saveAvatar('face:9'));
  await step('photo #1', async () => uploadAvatarPhoto(jpeg(), (await fetchProfile())?.avatar ?? null));
  await step('photo #2', async () => uploadAvatarPhoto(jpeg(), (await fetchProfile())?.avatar ?? null));
  await step('face 1 after a photo', () => saveAvatar('face:1'));

  const { error: restoreError } = await supabase.from('profiles').update({ avatar: original }).eq('id', uid);
  const { data: files } = await supabase.storage.from('avatars').list(uid);
  if (files?.length) await supabase.storage.from('avatars').remove(files.map((f) => `${uid}/${f.name}`));
  console.log(
    'restored to', original,
    restoreError ? `(could not: ${restoreError.message})` : '',
    '| removed', files?.length ?? 0, 'photo(s)',
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
