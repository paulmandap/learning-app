/**
 * Is Nomi seen moving where the owner asked? (NOTES §45)
 *
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/nomi-moves-probe.ts [--out <dir>]
 *
 * The owner, again: *"i still don't see the studying/focused animation"*; and on
 * the Nomi tab, idle with a wave from time to time, and a reaction on coming back
 * after a round. Watching the owl's layers in the built app, as TEST_USER_A at
 * phone width in dark, with reduce motion pinned off:
 *
 *  1. a probe set of three flashcards is made, and its deck opened — Nomi beside
 *     the count must move through several poses with its eyes on the page;
 *  2. every card is answered "Got it" — then back to Home, where Nomi must hop
 *     (success) as it comes into view;
 *  3. Home left alone — Nomi must raise a wing to wave within the first wave's
 *     window after its line is said.
 *
 * Reads each layer's transform as react-native-web writes it — the figure's
 * first translateY is the lift, the right wing's rotate is the wave — sampled
 * every 100 ms. Deletes the probe set afterwards (its answers go with it).
 */
import { join } from 'node:path';
import { openPage, type Page } from './screenshot';
import { supabase } from '../src/data/supabase';
import { IDLE_GREETING } from '../src/core/nomi-motion';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const OUT = outAt === -1 ? '.' : args[outAt + 1]!;
const TITLE = 'Nomi moves probe set';

/**
 * The owl's layers, found by their pictures, and their transforms as numbers.
 *
 * react-native-web draws a picture as a div inside the Image's own wrapper, so
 * the wing layer is found by walking up to the first ancestor that rotates. The
 * first version took the wrapper's parent for the wing and the wing for the
 * whole owl, and read a fixed pivot offset as a "hop" (NOTES §45).
 */
const SAMPLER = String.raw`(() => {
  const layers = [...document.querySelectorAll('div')].filter((d) => /nomi-wing-right/.test(getComputedStyle(d).backgroundImage));
  return layers.map((wingPicture) => {
    let wing = wingPicture.parentElement;               // up to the rotating wing layer
    while (wing && !/rotate\(/.test(wing.style.transform || '')) wing = wing.parentElement;
    const figure = wing && wing.parentElement;          // the whole owl: lift, tilt, scale
    const eye = figure && figure.children[1];           // the left eye: look and blink
    window.__rawNomi = { wing: wing && wing.style.transform, figure: figure && figure.style.transform, eye: eye && eye.style.transform };
    const nums = (el, fn) => {
      const m = el ? [...(el.style.transform || '').matchAll(new RegExp(fn + '\\(([-0-9.e]+)', 'g'))] : [];
      return m.map((x) => Number(x[1]));
    };
    const rect = figure ? figure.getBoundingClientRect() : { height: 0 };
    return {
      height: Math.round(rect.height),
      lift: nums(figure, 'translateY')[0] ?? 0,
      tilt: nums(figure, 'rotate')[0] ?? 0,
      wing: Math.abs(nums(wing, 'rotate')[0] ?? 0),
      lookX: nums(eye, 'translateX')[0] ?? 0,
      lookY: nums(eye, 'translateY')[0] ?? 0,
    };
  });
})()`;

type Pose = { height: number; lift: number; tilt: number; wing: number; lookX: number; lookY: number };

async function sample(page: Page, ms: number): Promise<Pose[]> {
  const poses: Pose[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const owls = await page.evaluate<Pose[]>(SAMPLER);
    if (owls[0]) poses.push(owls[0]);
    await new Promise((r) => setTimeout(r, 100));
  }
  return poses;
}

const distinct = (poses: Pose[]) =>
  new Set(poses.map((p) => [p.lift, p.tilt, p.wing, p.lookX, p.lookY].map((n) => n.toFixed(1)).join(','))).size;

async function main() {
  const email = process.env.TEST_USER_A_EMAIL;
  const password = process.env.TEST_USER_A_PASSWORD;
  if (!email || !password) throw new Error('Set TEST_USER_A_EMAIL and TEST_USER_A_PASSWORD.');
  const { data: auth, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in: ${error.message}`);
  const uid = auth.user!.id;

  // A set of its own, so answering it touches nothing the account already had.
  await supabase.from('study_sets').delete().eq('title', TITLE);
  const { data: set, error: setError } = await supabase
    .from('study_sets')
    .insert({ user_id: uid, title: TITLE, status: 'ready' })
    .select('id')
    .single();
  if (setError || !set) throw new Error(`probe set: ${setError?.message}`);
  const cards = [
    ['What do plants release during photosynthesis?', 'Oxygen'],
    ['Where does the Calvin cycle take place?', 'The stroma'],
    ['Which pigment absorbs light in a leaf?', 'Chlorophyll'],
  ].map(([prompt, answer]) => ({
    user_id: uid,
    study_set_id: set.id,
    kind: 'flashcard',
    level: 'remember',
    prompt,
    answer,
    source_excerpt: answer,
    excerpt_verified: true,
    topic: 'probe',
  }));
  const { error: itemsError } = await supabase.from('study_items').insert(cards);
  if (itemsError) throw new Error(`probe cards: ${itemsError.message}`);

  const page = await openPage({ width: 393, height: 900, dark: true, reducedMotion: 'no-preference' });
  const results: string[] = [];
  let failed = false;
  const check = (ok: boolean, line: string) => {
    results.push(`${ok ? 'OK ' : 'NO '} ${line}`);
    failed ||= !ok;
  };

  try {
    // 1. Studying, beside the count. Opened from Home by moving within the app,
    // as a tap does. page.goto() reloads the page, and a reload forgets the
    // round just finished — the first run of this probe did exactly that and
    // reported no hop. A marker on the page proves no reload happened.
    await page.waitFor(`document.querySelector('[aria-label^="Talk to Nomi."]') ? 'y' : ''`, "Nomi's card on Home", 20_000);
    await page.evaluate(`(() => {
      window.__sameVisit = true;
      history.pushState({}, '', '/set/${set.id}/flashcards?level=remember');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    })()`);
    await page.waitFor(`document.querySelector('#root').innerText.includes('0 of 3') ? 'y' : ''`, 'the deck');
    const studying = await sample(page, 4000);
    console.log(`raw transforms, last sample: ${JSON.stringify(await page.evaluate('window.__rawNomi'))}`);
    await page.screenshot(join(OUT, 'nomi-45-3-studying.png'));
    const eyesDown = studying.filter((p) => p.lookY > 0).length;
    check(
      studying.length > 0 && distinct(studying) >= 6 && eyesDown === studying.length,
      `studying beside the count: ${distinct(studying)} poses in ${studying.length} samples, eyes down in ${eyesDown}, owl ${studying[0]?.height ?? 0}px`,
    );

    // 2. Every card "Got it", then Home.
    for (let i = 0; i < 3; i++) {
      await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight' }))`);
      await new Promise((r) => setTimeout(r, 500));
    }
    await page.waitFor(`document.querySelector('#root').innerText.includes('Done') ? 'y' : ''`, 'the finished deck');
    await new Promise((r) => setTimeout(r, 1800));
    await page.evaluate(`history.back()`);
    await page.waitFor(`location.pathname === '/' ? 'y' : ''`, 'Home', 20_000);
    await page.waitFor(`document.querySelector('[aria-label^="Talk to Nomi."]') ? 'y' : ''`, "Nomi's card", 20_000);
    const back = await sample(page, 2500);
    const sameVisit = await page.evaluate<boolean>(`window.__sameVisit === true`);
    check(sameVisit, `back on Home without reloading the page: ${sameVisit}`);
    const hop = Math.min(...back.map((p) => p.lift));
    check(hop <= -0.04 * (back[0]?.height ?? 92), `back on Home after 3 of 3: highest hop ${hop.toFixed(1)}px on a ${back[0]?.height ?? 0}px owl`);

    // 3. A wave, within the first wave's window once the line is said.
    const waiting = await sample(page, 6000 + IDLE_GREETING.firstMs[1] + 2000);
    const wave = Math.max(...waiting.map((p) => p.wing));
    check(wave >= 100, `left on Home for ${(waiting.length / 10).toFixed(0)}s: wing raised to ${wave.toFixed(0)}°`);
  } finally {
    const errors = page.logs().filter((l) => l.startsWith('[exception]') || l.startsWith('[error]'));
    if (errors.length) console.log(`--- page errors ---\n${errors.slice(-10).join('\n')}`);
    await page.close();
    const { error: cleanup } = await supabase.from('study_sets').delete().eq('id', set.id);
    console.log(cleanup ? `could not delete the probe set: ${cleanup.message}` : 'deleted the probe set');
  }

  for (const line of results) console.log(line);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
