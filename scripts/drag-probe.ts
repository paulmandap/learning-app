/**
 * Drag a set into a folder with a real mouse and a real finger, and ask the
 * database whether it moved (NOTES §48).
 *
 *   npx tsx --env-file=.env scripts/drag-probe.ts [--shot <file.png>]
 *
 * Needs TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD and a built `dist/`. Makes one
 * folder on the test account and removes it afterwards, and puts the set it
 * moves back where it was.
 *
 * ## Four cases, because the owner's spec has four edges
 *
 *   1. mouse, held 400ms (past 250), dragged onto the folder  -> moves
 *   2. finger, held 500ms (short of 1000), then dragged       -> must NOT move
 *   3. finger, held 1200ms (past 1000), dragged onto it       -> moves
 *   4. mouse, a plain click                                   -> opens the set, moves nothing
 *
 * Through Chrome's own input API (`Input.dispatchMouseEvent`,
 * `Input.dispatchTouchEvent`), so the page receives trusted events with the
 * right `pointerType` — which is the fact the hold delay is chosen by. A
 * dispatched DOM event would not tell a finger from a mouse, and would not have
 * caught that the first version could not be dragged by a mouse at all.
 *
 * ## Six checks or it tested nothing
 *
 * Its first run threw before any check and printed "all passed". It now counts
 * the checks and fails unless all six ran — the vacuous pass HANDOFF warns
 * about by name.
 *
 * ## Wait for the page to STOP moving before measuring it
 *
 * Home settles in stages: Nomi types its line, the counts arrive, the Continue
 * card fills. A set's position measured before that is not where it is a moment
 * later, and a press aimed at the old spot lands on something else — which
 * failed the mouse case once in four runs, against an app that was working.
 */
import { createClient } from '@supabase/supabase-js';
import { openPage } from './screenshot';
import { formatSetTitle } from '../src/core/title';

const FOLDER = 'Drag probe folder';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const shotAt = process.argv.indexOf('--shot');
  const shot = shotAt === -1 ? null : process.argv[shotAt + 1];

  const db = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL!,
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
  const { data: auth, error } = await db.auth.signInWithPassword({
    email: process.env.TEST_USER_A_EMAIL!,
    password: process.env.TEST_USER_A_PASSWORD!,
  });
  if (error || !auth.user) throw new Error(`sign-in: ${error?.message ?? 'no user'}`);

  // A leftover from a run that died half way would make two folders of one name.
  await db.from('folders').delete().eq('name', FOLDER);
  const { data: f, error: fErr } = await db
    .from('folders')
    .insert({ user_id: auth.user.id, name: FOLDER })
    .select('id')
    .single();
  if (fErr) throw new Error(`could not make a folder (is 0024 applied?): ${fErr.message}`);
  const folderId = (f as { id: string }).id;

  const { data: sets } = await db.from('study_sets').select('id, title').is('folder_id', null);
  const target = (sets ?? [])[0] as { id: string; title: string } | undefined;
  if (!target) throw new Error('the test account has no set outside a folder to drag');
  // What the row says on screen — the stored title is formatted before it is shown.
  const shown = formatSetTitle(target.title);

  const folderOf = async () =>
    ((await db.from('study_sets').select('folder_id').eq('id', target.id).single()).data as {
      folder_id: string | null;
    }).folder_id;
  const reset = () => db.from('study_sets').update({ folder_id: null }).eq('id', target.id);

  let failures = 0;
  let checks = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    checks++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
    if (!ok) failures++;
  };

  // Tall enough that the whole list is on screen: this is about the drag, and
  // scroll-probe.ts is about scrolling.
  const page = await openPage({ width: 393, height: 1500, dark: true });

  const where = async () =>
    JSON.parse(
      await page.evaluate<string>(`(() => {
        const btns = [...document.querySelectorAll('[role="button"]')];
        const folder = btns.find((b) => (b.getAttribute('aria-label') || '').startsWith(${JSON.stringify(FOLDER + ',')}));
        const set = btns.find((b) => (b.innerText || '').trim().startsWith(${JSON.stringify(shown)}));
        if (!folder || !set) return JSON.stringify({ missing: !folder ? 'folder' : 'set' });
        const c = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
        return JSON.stringify({ set: c(set), folder: c(folder) });
      })()`),
    ) as { set: { x: number; y: number }; folder: { x: number; y: number }; missing?: string };

  /** Open Home and wait until nothing on it is still moving. */
  const settle = async () => {
    await page.goto('/');
    await page.waitFor(`document.body.innerText.includes(${JSON.stringify(FOLDER)}) ? 'y' : ''`, 'the folder row');
    let last = '';
    for (let i = 0; i < 40; i++) {
      const now = JSON.stringify(await where());
      if (now === last && !now.includes('missing')) break;
      last = now;
      await sleep(250);
    }
    const p = await where();
    if (p.missing) throw new Error(`could not find the ${p.missing} row`);
    return p;
  };

  const path = (from: { x: number; y: number }, to: { x: number; y: number }, i: number) => ({
    x: Math.round(from.x + ((to.x - from.x) * i) / 10),
    y: Math.round(from.y + ((to.y - from.y) * i) / 10),
  });

  try {
    // ---- 1. mouse ----------------------------------------------------------
    let p = await settle();
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p.set, button: 'none', buttons: 0 });
    await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...p.set, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(400);
    for (let i = 1; i <= 10; i++) {
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...path(p.set, p.folder, i), button: 'left', buttons: 1 });
      await sleep(30);
    }
    if (shot) await page.screenshot(shot);
    const overText = await page.text();
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p.folder, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(1500);
    const says = `Let go to put it in ${FOLDER}`;
    check('mouse: the carried set says where it will land', overText.includes(says), overText.includes(says) ? `"${says}"` : 'not said');
    check('mouse: held 400ms and dropped on the folder', (await folderOf()) === folderId, `folder_id = ${await folderOf()}`);
    await reset();

    // ---- 2. finger, held too briefly --------------------------------------
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    p = await settle();
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p.set] });
    await sleep(500);
    for (let i = 1; i <= 10; i++) {
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [path(p.set, p.folder, i)] });
      await sleep(30);
    }
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(1500);
    check('finger: held only 500ms, then moved', (await folderOf()) === null, `folder_id = ${await folderOf()} (a scroll is not a pickup)`);
    await reset();

    // ---- 3. finger, a full second -----------------------------------------
    p = await settle();
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p.set] });
    await sleep(1200);
    for (let i = 1; i <= 10; i++) {
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [path(p.set, p.folder, i)] });
      await sleep(30);
    }
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(1500);
    check('finger: held 1200ms and dropped on the folder', (await folderOf()) === folderId, `folder_id = ${await folderOf()}`);
    await reset();

    // ---- 4. a plain click still opens the set -----------------------------
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
    p = await settle();
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p.set, button: 'none', buttons: 0 });
    await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...p.set, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(80);
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p.set, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(1200);
    const at = await page.evaluate<string>('location.pathname');
    check('mouse: a plain click opens the set', at.startsWith('/set/'), `now at ${at}`);
    check('mouse: and moves nothing', (await folderOf()) === null, `folder_id = ${await folderOf()}`);
  } finally {
    await page.close();
    await reset();
    await db.from('folders').delete().eq('name', FOLDER);
    const ok = failures === 0 && checks === 6;
    console.log(ok ? `\nall ${checks} drag checks passed.` : `\n${failures} failed, ${checks} of 6 ran.`);
    process.exitCode = ok ? 0 : 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
