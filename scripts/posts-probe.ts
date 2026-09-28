/**
 * Posts, the feed, comments and reactions — in the built app, as two real
 * people (NOTES §52).
 *
 * `scripts/isolation-test.ts` proves who can read and write what. This proves
 * the screens, and after every step asks the DATABASE whether it agrees: a
 * friend's post in the feed; a photo actually loading; a reaction and a comment
 * landing; a post written in the composer, for everyone, carrying a shared set
 * whose cards flip right there in the feed; an edit marked; a delete gone; B's
 * posts on B's page.
 *
 * Run:
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/posts-probe.ts [--out <dir>]
 *
 * Needs migrations 0026 and 0027, and TEST_USER_A_* / TEST_USER_B_*. Signs in to
 * the app as A; B posts from the data layer. Cleans up after itself.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { openPage, type Page } from './screenshot';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishable = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const creds = {
  a: { email: process.env.TEST_USER_A_EMAIL, password: process.env.TEST_USER_A_PASSWORD },
  b: { email: process.env.TEST_USER_B_EMAIL, password: process.env.TEST_USER_B_PASSWORD },
};
if (!url || !publishable || !creds.a.email || !creds.b.email) {
  console.error('Missing the Supabase settings or TEST_USER_A_* / TEST_USER_B_*.');
  process.exit(2);
}

/** Every probe post starts with this, so the cleanup sweeps what a failed run left. */
const MARK = 'posts probe';
const B_TEXT = `${MARK}: hello from B`;
const B_PHOTO = `${MARK}: a photo from B`;
const A_TEXT = `${MARK}: my set`;
const SET_TITLE = 'Posts probe set';
const CARD_Q = 'What does the posts probe card ask?';
const CARD_A = 'Whether the feed can flip it.';

/**
 * A photo worth looking at, drawn by the browser: 640x480, a gradient and some
 * words. The first run used scripts/avatar-probe.ts's 1x1 JPEG, which loaded —
 * the probe said so — and photographed as an empty dark box, so the photograph
 * could not show whether a photo appears. No image library for this: the page's
 * own canvas makes the JPEG, the same way `shrinkImage` does in the app.
 */
const DRAW_PHOTO = `(() => {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 480;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 640, 480);
  grad.addColorStop(0, '#6bb8c9'); grad.addColorStop(1, '#f0c27a');
  g.fillStyle = grad; g.fillRect(0, 0, 640, 480);
  g.fillStyle = '#10181e'; g.font = 'bold 44px sans-serif';
  g.fillText('posts probe photo', 60, 250);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
})()`;

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

async function signIn(which: 'a' | 'b'): Promise<{ client: SupabaseClient; userId: string }> {
  const client = createClient(url!, publishable!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: creds[which].email!,
    password: creds[which].password!,
  });
  if (error || !data.user) throw new Error(`Could not sign in ${which}: ${error?.message}`);
  return { client, userId: data.user.id };
}

/** Words anywhere on the page — sheets are Modals, drawn outside #root (NOTES §51.8). */
const showing = (page: Page, words: string, timeoutMs?: number) =>
  page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(words)}) ? 'y' : ''`,
    `"${words}" on screen`,
    timeoutMs,
  );

/**
 * Press a control inside the card that holds some words — every post has its
 * own React, Comment and ⋯, so a plain click would press the first post's.
 */
async function clickInCard(page: Page, cardText: string, label: string): Promise<void> {
  await page.waitFor(
    `[...document.querySelectorAll('[role="button"]')].some((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)}) ? 'y' : ''`,
    `a "${label}" control`,
  );
  // The button whose NEAREST ancestor holding the words is closest. The first
  // version took the first button with any ancestor holding them — and the list
  // around every post holds every post's words, so it pressed the newest post's
  // React and opened the wrong post (measured on this probe's first run).
  const done = await page.evaluate<string>(`(() => {
    let best = null, bestDepth = Infinity;
    for (const b of document.querySelectorAll('[role="button"]')) {
      if (b.getAttribute('aria-label') !== ${JSON.stringify(label)}) continue;
      let el = b;
      for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
        if (el.innerText && el.innerText.includes(${JSON.stringify(cardText)})) {
          if (i < bestDepth) { best = b; bestDepth = i; }
          break;
        }
      }
    }
    if (!best) return '';
    best.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    best.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    best.click();
    return 'ok';
  })()`);
  if (!done) throw new Error(`No "${label}" in the card with "${cardText}"`);
}

/** Type into one field, found by its placeholder. */
async function typeInto(page: Page, placeholder: string, value: string): Promise<void> {
  const done = await page.evaluate<string>(`(() => {
    const el = [...document.querySelectorAll('input, textarea')]
      .find((e) => e.getAttribute('placeholder') === ${JSON.stringify(placeholder)});
    if (!el) return '';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === ${JSON.stringify(value)} ? 'ok' : '';
  })()`);
  if (!done) throw new Error(`Could not type into "${placeholder}"`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (outDir) await page.screenshot(join(outDir, name));
}

async function main() {
  console.log('Posts probe\n');
  const A = await signIn('a');
  const B = await signIn('b');

  // Both test accounts agree to the community rules (0030, NOTES §55): every
  // social act below is refused with 'RULES' until they have. A database
  // without 0030 has no such function, which is fine.
  await A.client.rpc('accept_community_rules');
  await B.client.rpc('accept_community_rules');

  const gate = await A.client.from('feed_posts').select('id').limit(1);
  if (gate.error) {
    console.error(`feed_posts is not readable (${gate.error.code}): is migration 0027 applied?`);
    process.exit(2);
  }

  const photoPath = `${B.userId}/posts-probe.jpg`;
  const clean = async () => {
    await A.client.from('posts').delete().like('body', `${MARK}%`);
    await B.client.from('posts').delete().like('body', `${MARK}%`);
    await B.client.storage.from('post-images').remove([photoPath]);
    await A.client.from('study_sets').delete().eq('title', SET_TITLE);
    await A.client.from('blocks').delete().eq('blocker_id', A.userId);
    await B.client.from('blocks').delete().eq('blocker_id', B.userId);
    await A.client.from('friendships').delete().or(`requester_id.eq.${B.userId},addressee_id.eq.${B.userId}`);
  };
  await clean();

  const page = await openPage({ width: 393, height: 852, dark: true });
  const photoB64 = await page.evaluate<string>(DRAW_PHOTO);

  // ---- seed: friends, B's two posts, A's shared set ----
  await A.client.from('profiles').update({ display_name: 'Probe A' }).eq('id', A.userId);
  const bBefore = await B.client.from('profiles').select('display_name').eq('id', B.userId).maybeSingle();
  await B.client.from('profiles').update({ display_name: 'Probe B' }).eq('id', B.userId);
  await B.client.rpc('send_friend_request', { p_to: A.userId });
  await A.client.rpc('accept_friend_request', { p_from: B.userId });

  const bText = await B.client.rpc('create_post', { p_body: B_TEXT, p_audience: 'friends' });
  const up = await B.client.storage
    .from('post-images')
    .upload(photoPath, new Blob([Buffer.from(photoB64, 'base64')], { type: 'image/jpeg' }), { upsert: true });
  const bPhoto = up.error
    ? { error: up.error, data: null }
    : await B.client.rpc('create_post', {
        p_body: B_PHOTO,
        p_audience: 'everyone',
        p_image_path: photoPath,
        p_image_width: 640,
        p_image_height: 480,
      });
  if (bText.error || bPhoto.error) throw new Error(`Seed failed: ${bText.error?.message ?? ''} ${bPhoto.error?.message ?? ''}`);
  const bTextId = bText.data as string;

  const { data: set, error: setErr } = await A.client
    .from('study_sets')
    .insert({ user_id: A.userId, title: SET_TITLE, status: 'ready', visibility: 'public', published_at: new Date().toISOString() })
    .select('id')
    .single();
  if (setErr || !set) throw new Error(`Seed failed (set): ${setErr?.message}`);
  const setId = (set as { id: string }).id;
  await A.client.from('study_items').insert([
    { user_id: A.userId, study_set_id: setId, page_index: 0, kind: 'flashcard', level: 'remember', prompt: CARD_Q, answer: CARD_A, source_excerpt: 'The posts probe card.', excerpt_verified: true, hidden: false },
    { user_id: A.userId, study_set_id: setId, page_index: 0, kind: 'flashcard', level: 'remember', prompt: 'A second card?', answer: 'Yes.', source_excerpt: 'A second card.', excerpt_verified: true, hidden: false },
  ]);

  try {
    console.log('A, in the built app:');

    // ---- the feed ----
    await page.goto('/community');
    await showing(page, B_TEXT);
    const feed = await page.evaluate<string>('document.body.innerText');
    // Who can see it is an icon since the redesign (NOTES §57), named for a
    // screen reader — so it is read from its label, not from the words.
    const audience = await page.evaluate<boolean>(`!!document.querySelector('[aria-label="Seen by friends"]')`);
    if (feed.includes('Probe B') && audience) ok('feed', "a friend's friends-only post, with who can see it");
    else fail('feed', 'the post is there without its author or its audience');
    await showing(page, B_PHOTO);
    await page.waitFor(
      `[...document.images].some((i) => i.src.includes('/post-images/') && i.complete && i.naturalWidth > 0) ? 'y' : ''`,
      'the photo to load',
    );
    ok('photo', 'loaded through a signed link, as a friend');
    await shot(page, '01-feed.png');

    // ---- react: the heart under the post (NOTES §57; it was React, then Heart) ----
    await clickInCard(page, B_TEXT, 'Heart');
    await page.waitFor(
      `[...document.querySelectorAll('[role="button"]')].some((b) => b.getAttribute('aria-label') === 'Remove heart') ? 'y' : ''`,
      'the heart to fill',
    );
    const reacted = await A.client.from('post_reactions').select('emoji').eq('post_id', bTextId).eq('user_id', A.userId);
    if ((reacted.data ?? []).some((r: { emoji: string }) => r.emoji === '❤️')) ok('react', 'on screen and in the database');
    else fail('react', 'the chip shows and the database has no heart');

    // ---- comment ----
    await clickInCard(page, B_TEXT, 'Comment');
    await page.waitFor(`location.pathname === '/post/${bTextId}' ? 'y' : ''`, 'the post to open');
    await showing(page, 'No comments yet');
    await typeInto(page, 'Write a comment', `${MARK} comment`);
    await page.click('Send');
    await showing(page, 'Comments (1)');
    const commented = await A.client.from('post_comments').select('body').eq('post_id', bTextId).eq('user_id', A.userId);
    if ((commented.data ?? []).length === 1) ok('comment', 'on screen and in the database');
    else fail('comment', `the database has ${JSON.stringify(commented.data)}`);

    // ---- replies, hearts on comments, saves (0031, NOTES §57) ----
    const has0031 = !(await A.client.from('comment_likes').select('comment_id').limit(1)).error;
    const aCommentId = ((commented.data ?? [])[0] as { id?: string } | undefined)?.id
      ?? (((await A.client.from('post_comments').select('id').eq('post_id', bTextId).eq('user_id', A.userId)).data ?? [])[0] as { id: string } | undefined)?.id;
    if (!has0031) {
      console.log('  NOTE  replies, hearts and saves — migration 0031 not applied, not checked');
    } else {
      await page.click('Heart this comment');
      await page.waitFor(
        `[...document.querySelectorAll('[role="button"]')].some((b) => b.getAttribute('aria-label') === 'Remove your heart from this comment') ? 'y' : ''`,
        "the comment's heart to fill",
      );
      const hearted = await A.client.from('comment_likes').select('comment_id').eq('user_id', A.userId).eq('comment_id', aCommentId ?? '');
      if ((hearted.data ?? []).length === 1) ok('heart a comment', 'on screen and in the database');
      else fail('heart a comment', `the database has ${JSON.stringify(hearted.data)}`);

      await page.click('Reply to Probe A');
      await showing(page, 'Replying to Probe A');
      await typeInto(page, 'Reply to Probe A', `${MARK} reply`);
      await page.click('Send');
      await showing(page, 'Comments (2)');
      const replied = await A.client.from('post_comments').select('parent_id').eq('post_id', bTextId).eq('body', `${MARK} reply`);
      if ((replied.data ?? []).some((r: { parent_id: string | null }) => r.parent_id === aCommentId)) {
        ok('reply', 'under the comment, on screen and in the database');
      } else fail('reply', `the database has ${JSON.stringify(replied.data)}`);
    }
    await shot(page, '02-post-comments.png');

    if (has0031) {
      await page.goto('/community');
      await showing(page, B_TEXT);
      await clickInCard(page, B_TEXT, 'Save post');
      await page.waitFor(
        `[...document.querySelectorAll('[role="button"]')].some((b) => b.getAttribute('aria-label') === 'Remove from saved') ? 'y' : ''`,
        'the bookmark to fill',
      );
      // Saved is a tab on Profile since §59.
      await page.goto('/profile');
      await page.click('Saved');
      await showing(page, 'Only you can see what you save.');
      await showing(page, B_TEXT);
      const savedRow = await A.client.from('post_saves').select('post_id').eq('user_id', A.userId).eq('post_id', bTextId);
      if ((savedRow.data ?? []).length === 1) ok('save', 'in Saved, and in the database');
      else fail('save', `the database has ${JSON.stringify(savedRow.data)}`);
      await shot(page, '02b-saved.png');
      await clickInCard(page, B_TEXT, 'Remove from saved');
      await page.waitFor(`document.body.innerText.includes('Nothing saved yet') ? 'y' : ''`, 'Saved to empty');
      const unsaved = await A.client.from('post_saves').select('post_id').eq('user_id', A.userId).eq('post_id', bTextId);
      if ((unsaved.data ?? []).length === 0) ok('unsave', 'gone from Saved and from the database');
      else fail('unsave', 'gone from the screen, still in the database');
    }

    // ---- write a post, with a set, for everyone ----
    await page.goto(`/post/new?set=${setId}`);
    await showing(page, SET_TITLE);
    await showing(page, 'Only your friends can see it.');
    await typeInto(page, 'What do you want to share?', A_TEXT);
    await page.click('Everyone');
    await showing(page, 'Anyone signed in to Nomi can see it.');
    await shot(page, '03-composer.png');
    await page.click('Post');
    await page.waitFor(`location.pathname === '/community' ? 'y' : ''`, 'back to the feed');
    await showing(page, A_TEXT);
    const mine = await A.client.from('posts').select('id, audience, set_id').eq('body', A_TEXT).maybeSingle();
    const row = mine.data as { id: string; audience: string; set_id: string } | null;
    if (row?.audience === 'everyone' && row.set_id === setId) ok('post', 'for everyone, with the set, as the composer said');
    else fail('post', `the database has ${JSON.stringify(mine.data)}`);

    // ---- flip the set's card in the feed ----
    await page.waitFor(
      `[...document.querySelectorAll('[role="button"]')].some((b) => (b.getAttribute('aria-label') ?? '').startsWith('Question: ${CARD_Q}')) ? 'y' : ''`,
      "the set's first card in the feed",
    );
    await page.click(`Question: ${CARD_Q}. Tap for the answer.`);
    await showing(page, CARD_A);
    ok('set in the feed', 'its card flips right there');
    await shot(page, '04-feed-set-flipped.png');

    // ---- edit it ----
    if (row) {
      await clickInCard(page, A_TEXT, 'More');
      await page.click('Edit post');
      await page.waitFor(`location.pathname === '/post/new' ? 'y' : ''`, 'the composer');
      await showing(page, 'Edit post');
      await typeInto(page, 'What do you want to share?', `${A_TEXT} (fixed)`);
      await page.click('Save');
      await showing(page, `${A_TEXT} (fixed)`);
      const edited = await A.client.from('posts').select('edited_at').eq('id', row.id).maybeSingle();
      if ((edited.data as { edited_at?: string } | null)?.edited_at && (await page.evaluate<string>('document.body.innerText')).includes('edited')) {
        ok('edit', 'saved, and marked edited');
      } else fail('edit', 'not marked edited');

      // ---- and delete it ----
      await clickInCard(page, `${A_TEXT} (fixed)`, 'More');
      await page.click('Delete post');
      await showing(page, 'Delete this post?');
      await page.click('Delete post');
      await page.waitFor(
        `document.body.innerText.includes(${JSON.stringify(`${A_TEXT} (fixed)`)}) ? '' : 'y'`,
        'the post to go',
      );
      const gone = await A.client.from('posts').select('id').eq('id', row.id);
      if ((gone.data ?? []).length === 0) ok('delete', 'gone from the feed and the database');
      else fail('delete', 'gone from the screen, still in the database');
    }

    // ---- B's page shows B's posts ----
    await page.goto(`/person/${B.userId}`);
    await showing(page, B_TEXT);
    ok("a person's page", "shows the posts A may see");

    const errors = page.logs().filter((l) => /uncaught|TypeError|ReferenceError/i.test(l));
    if (errors.length > 0) fail('browser console', errors.join(' | '));
    else ok('browser console', 'no uncaught errors');
  } catch (err) {
    fail('probe', err instanceof Error ? err.message : String(err));
    if (outDir) await page.screenshot(join(outDir, 'failed.png')).catch(() => {});
  } finally {
    await page.close();
    await clean();
    await B.client
      .from('profiles')
      .update({ display_name: (bBefore.data as { display_name?: string | null } | null)?.display_name ?? null })
      .eq('id', B.userId);
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
