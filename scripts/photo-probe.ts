/**
 * Choosing a photo, through the real screens — in the built app, as A (NOTES §61).
 *
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/photo-probe.ts [--out <dir>]
 *
 * The owner, on a second account on his iPhone: *"picked a picture, check
 * button, then nothing is happening. no errors"* — and storage had nothing.
 * `avatar-probe.ts` calls the data layer and never saw it: the upload was fine,
 * the picker was not. This goes through the screens instead: Settings' "Use a
 * photo" and the new post's Photo, each handed a large phone-sized photo
 * through the page's own file box — which it can only find because that box is
 * in the page now — and the database asked afterwards.
 *
 * Headless Chrome did not lose the old, detached box the way the iPhone did,
 * so this cannot show the old bug. What it holds is the path the fix takes:
 * the box is in the page when chosen from, gone after, and a big photo ends
 * in a saved picture.
 *
 * Restores A's picture and removes the photos it uploaded. Needs
 * TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { openPage, type Page } from './screenshot';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishable = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !publishable || !process.env.TEST_USER_A_EMAIL) {
  console.error('Missing the Supabase settings or TEST_USER_A_*.');
  process.exit(2);
}

const outDir = (() => {
  const i = process.argv.indexOf('--out');
  if (i === -1) return null;
  const dir = process.argv[i + 1]!;
  mkdirSync(dir, { recursive: true });
  return dir;
})();

let failures = 0;
let checks = 0;
const ok = (name: string, detail = '') => {
  checks++;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
};
const fail = (name: string, detail: string) => {
  checks++;
  failures++;
  console.error(`  FAIL  ${name} — ${detail}`);
};

/** Hand the page's file box a file, as choosing one in the picker does. */
async function choose(page: Page, file: string): Promise<void> {
  const { root } = (await page.cdp('DOM.getDocument', { depth: 0 })) as { root: { nodeId: number } };
  const { nodeId } = (await page.cdp('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })) as {
    nodeId: number;
  };
  if (!nodeId) throw new Error('no file box in the page');
  await page.cdp('DOM.setFileInputFiles', { nodeId, files: [file] });
}

const boxInPage = `document.querySelector('input[type=file]') ? 'y' : ''`;

async function main() {
  console.log('Photo probe\n');
  const db = createClient(url!, publishable!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error } = await db.auth.signInWithPassword({
    email: process.env.TEST_USER_A_EMAIL!,
    password: process.env.TEST_USER_A_PASSWORD!,
  });
  if (error || !auth.user) throw new Error(`sign-in: ${error?.message}`);
  const uid = auth.user.id;
  const avatarNow = async () =>
    ((await db.from('profiles').select('avatar').eq('id', uid).maybeSingle()).data as { avatar?: string | null } | null)
      ?.avatar ?? null;
  const original = await avatarNow();
  const filesBefore = new Set(((await db.storage.from('avatars').list(uid)).data ?? []).map((f) => f.name));

  const scratch = join(tmpdir(), `photo-probe-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  const page = await openPage({ width: 393, height: 852, dark: true });
  try {
    // A phone-sized photo, 4032 × 3024, made in the page and saved to disk.
    await page.goto('/settings');
    const dataUrl = await page.evaluate<string>(`(() => {
      const c = document.createElement('canvas');
      c.width = 4032; c.height = 3024;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 4032, 3024);
      grad.addColorStop(0, '#6cb7c9'); grad.addColorStop(1, '#f0c07f');
      g.fillStyle = grad; g.fillRect(0, 0, 4032, 3024);
      for (let i = 0; i < 400; i++) { g.fillStyle = 'hsl(' + (i * 37) % 360 + ',60%,50%)'; g.fillRect((i * 97) % 4000, (i * 61) % 3000, 60, 60); }
      return c.toDataURL('image/jpeg', 0.92);
    })()`);
    const photo = join(scratch, 'phone-photo.jpg');
    writeFileSync(photo, Buffer.from(dataUrl.split(',')[1]!, 'base64'));
    console.log(`  (a ${Math.round(Buffer.byteLength(dataUrl) * 0.75 / 1024)} KB, 4032 × 3024 photo)`);

    // No picker window in headless Chrome: the box is filled directly.
    await page.cdp('Page.setInterceptFileChooserDialog', { enabled: true });

    // ---- Settings: Use a photo ----
    await page.waitFor(`document.body.innerText.includes('Use a photo') ? 'y' : ''`, 'Settings');
    await page.click('Use a photo');
    await page.waitFor(boxInPage, 'the file box, in the page');
    ok('the box is in the page', 'while the photo library would be open');
    await choose(page, photo);

    // The editor (NOTES §63): the photo in the circle, zoomed in twice, saved.
    await page.waitFor(`document.body.innerText.includes('Edit photo') ? 'y' : ''`, 'the photo editor');
    const slider = `document.querySelector('[aria-label="Zoom"]')`;
    await page.waitFor(`${slider} ? 'y' : ''`, 'the zoom slider');
    await page.waitFor(`document.body.innerText.includes('Opening your photo') ? '' : 'y'`, 'the photo to open');
    console.log(`  (the slider says: ${await page.evaluate<string>(`[...${slider}.attributes].map((a) => a.name + '=' + a.value).join(' ')`)})`);
    await page.click('Zoom in');
    await page.click('Zoom in');
    const zoom = await page.evaluate<string>(`${slider}.getAttribute('aria-valuenow') ?? ''`);
    if (Number(zoom) > 100) ok('editor', `the photo in a circle, zoomed to ${zoom}%`);
    else fail('editor', `the zoom says ${zoom}`);
    if (outDir) await page.screenshot(join(outDir, '00-editor.png'));
    await page.click('Save');

    let saved: string | null = null;
    for (let i = 0; i < 60 && !saved; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const now = await avatarNow();
      if (now && now !== original && now.startsWith('photo:')) saved = now;
    }
    if (saved) ok('profile photo', `saved as ${saved.slice(0, 60)}…`);
    else fail('profile photo', `the profile still says ${await avatarNow()}`);

    const files = ((await db.storage.from('avatars').list(uid)).data ?? []).filter((f) => !filesBefore.has(f.name));
    const size = (files[0]?.metadata as { size?: number } | undefined)?.size ?? 0;
    if (files.length === 1 && size > 0 && size < 100_000) ok('made small first', `${Math.round(size / 1024)} KB stored, not the camera's size`);
    else fail('made small first', `${files.length} new file(s), ${size} bytes`);

    if ((await page.evaluate<string>(boxInPage)) === '') ok('the box is gone after', 'nothing left in the page');
    else fail('the box is gone after', 'a file box is still in the page');
    if (outDir) await page.screenshot(join(outDir, '01-settings-photo.png'));

    // ---- a new post: Photo ----
    await page.goto('/community');
    await page.click('Write a post');
    await page.waitFor(`location.pathname === '/post/new' ? 'y' : ''`, 'the composer');
    await page.click('Add a photo');
    await page.waitFor(boxInPage, 'the file box, in the page');
    await choose(page, photo);
    await page.waitFor(
      `document.querySelector('[aria-label="The photo you picked"]') ? 'y' : ''`,
      'the photo in the new post',
    );
    ok('post photo', 'the big photo is read, made small and shown in the box');
    if (outDir) await page.screenshot(join(outDir, '02-post-photo.png'));
    await page.click('Cancel');
    await page.click('Throw away');

    const errors = page.logs().filter((l) => /uncaught|TypeError|ReferenceError/i.test(l));
    if (errors.length > 0) fail('browser console', errors.join(' | '));
    else ok('browser console', 'no uncaught errors');
  } catch (err) {
    fail('probe', err instanceof Error ? err.message : String(err));
    if (outDir) await page.screenshot(join(outDir, 'failed.png')).catch(() => {});
  } finally {
    await page.close();
    await db.from('profiles').update({ avatar: original }).eq('id', uid);
    const added = ((await db.storage.from('avatars').list(uid)).data ?? []).filter((f) => !filesBefore.has(f.name));
    if (added.length) await db.storage.from('avatars').remove(added.map((f) => `${uid}/${f.name}`));
    rmSync(scratch, { recursive: true, force: true });
    console.log(`  (restored the picture to ${original}; removed ${added.length} photo(s))`);
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
