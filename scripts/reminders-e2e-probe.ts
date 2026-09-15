/**
 * Reminders end to end, against the live database (NOTES §45).
 *
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/reminders-e2e-probe.ts [--out <dir>]
 *
 * Once migration 0020 is applied. As TEST_USER_A in headless Chrome, this turns
 * reminders on from Settings the way a person does; checks the device and the
 * times were saved; runs the sender's own dry run, which must now count that
 * device; reads it back through reminders_to_send with the sender's secret;
 * sends THAT device one reminder through the real push service and waits for
 * the service worker to show it; marks it sent through reminders_sent, after
 * which the dry run must skip it; then turns reminders off from Settings and
 * checks nothing is left.
 *
 * Nobody else is sent anything: only the test's own device, found by its own
 * address. Needs REMINDER_SENDER_SECRET and VAPID_PRIVATE_KEY from .env.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { openPage } from './screenshot';
import { sendPush } from './web-push';
import { supabase } from '../src/data/supabase';
import { CONTACT_EMAIL } from '../src/core/legal';
import {
  ALL_SLOTS,
  reminderCounts,
  reminderMessage,
  reminderPayload,
  REMINDER_TTL_SECONDS,
  VAPID_PUBLIC_KEY,
} from '../src/core/reminders';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const OUT = outAt === -1 ? '.' : args[outAt + 1]!;

interface Device {
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  last_sent_at: string | null;
  study_days: string[];
  due_at: string[];
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

/** The sender itself, as the workflow runs it, but only counting. */
function dryRun(): string {
  const run = spawnSync('npx tsx --env-file=.env scripts/send-reminders.ts --slot evening --dry-run', {
    shell: true,
    encoding: 'utf8',
  });
  return `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
}

async function main() {
  const url = need('EXPO_PUBLIC_SUPABASE_URL');
  const publishable = need('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const secret = need('REMINDER_SENDER_SECRET');
  const privateKey = need('VAPID_PRIVATE_KEY');
  const { data: auth, error } = await supabase.auth.signInWithPassword({
    email: need('TEST_USER_A_EMAIL'),
    password: need('TEST_USER_A_PASSWORD'),
  });
  if (error) throw new Error(`sign-in: ${error.message}`);
  const uid = auth.user!.id;

  const results: string[] = [];
  let failed = false;
  const check = (ok: boolean, line: string) => {
    results.push(`${ok ? 'OK ' : 'NO '} ${line}`);
    failed ||= !ok;
  };

  await supabase.from('reminder_settings').delete().eq('user_id', uid);
  const page = await openPage({ width: 393, height: 1700, dark: true });
  let endpoint = '';

  try {
    await page.browser('Browser.grantPermissions', { origin: page.origin, permissions: ['notifications'] });

    // 1. On, from Settings.
    await page.goto('/settings');
    await page.waitFor(`document.querySelector('#root').innerText.includes('Turn on reminders') ? 'y' : ''`, 'the Reminders card', 20_000);
    await page.click('Turn on reminders');
    await page.waitFor(`document.querySelector('#root').innerText.includes('Reminders are on') ? 'y' : ''`, 'reminders to turn on', 30_000);
    await page.waitFor(`document.querySelector('#root').innerText.includes('Turn off reminders') ? 'y' : ''`, 'the card to show them on');
    endpoint = await page.evaluate<string>(
      `(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const subscription = registration && (await registration.pushManager.getSubscription());
        return subscription ? subscription.endpoint : '';
      })()`,
      true,
    );
    await page.screenshot(join(OUT, 'reminders-45-on.png'));
    const note = await page.evaluate<string>(`(document.querySelector('#root').innerText.match(/Reminders are on[^\\n]*/) ?? [''])[0]`);
    check(endpoint.startsWith('https://'), `turned on from Settings: "${note}", subscribed at ${endpoint ? new URL(endpoint).host : 'nothing'}`);

    const { data: rows } = await supabase.from('push_subscriptions').select('id, last_sent_at').eq('endpoint', endpoint);
    const { data: settings } = await supabase.from('reminder_settings').select('slots').eq('user_id', uid).maybeSingle();
    const slots = (settings as { slots: string[] } | null)?.slots ?? [];
    check((rows ?? []).length === 1, `the device saved: ${(rows ?? []).length} row`);
    check(JSON.stringify(slots) === JSON.stringify(ALL_SLOTS), `the times saved: ${JSON.stringify(slots)}`);

    // 2. The sender's dry run counts it.
    const firstDry = dryRun();
    console.log(`dry run with the device on:  ${firstDry}`);
    check(/: [1-9]\d* device\(s\)/.test(firstDry) && /0 failed/.test(firstDry), 'the sender counts it');

    // 3. Read back as the sender reads it; send only this device.
    const response = await fetch(`${url}/rest/v1/rpc/reminders_to_send`, {
      method: 'POST',
      headers: { apikey: publishable, Authorization: `Bearer ${publishable}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_secret: secret, p_slot: 'evening' }),
    });
    const devices = (await response.json()) as Device[];
    const mine = devices.find((d) => d.endpoint === endpoint);
    check(response.ok && !!mine, `reminders_to_send returns it with the sender's secret (HTTP ${response.status})`);
    if (!mine) throw new Error('the device did not come back from reminders_to_send');

    const tonight = reminderMessage(reminderCounts({ studyDays: mine.study_days, dueAt: mine.due_at }, Date.now()));
    console.log(`what this account's evening reminder would say: ${tonight ? JSON.stringify(tonight) : 'nothing — it studied today'}`);
    // The account studied today in earlier probes, so the real sender would send
    // nothing; to prove delivery, this one device gets the no-due-cards wording.
    const reminder = tonight ?? reminderMessage({ due: 0, streak: 0, studiedToday: false })!;

    await page.evaluate(`(async () => { for (const n of await (await navigator.serviceWorker.ready).getNotifications()) n.close(); })()`, true);
    const sent = await sendPush(mine, reminderPayload(reminder), {
      keys: { publicKey: VAPID_PUBLIC_KEY, privateKey },
      subject: `mailto:${CONTACT_EMAIL}`,
      ttlSeconds: REMINDER_TTL_SECONDS,
      topic: 'nomi-reminder',
    });
    await page.evaluate(`(() => {
      window.__shown = '';
      const look = async () => {
        const shown = await (await navigator.serviceWorker.ready).getNotifications({ tag: 'nomi-reminder' });
        if (shown.length) window.__shown = JSON.stringify({ title: shown[0].title, body: shown[0].body });
        else setTimeout(look, 250);
      };
      look();
    })()`);
    const shown = await page.waitFor<string>(`window.__shown`, 'the reminder to be shown', 30_000);
    check(
      sent.outcome === 'sent' && shown === JSON.stringify(reminder),
      `sent through the push service (HTTP ${sent.status}) and shown: ${shown}`,
    );

    // 4. Marked sent, so a second run within two hours skips it.
    const mark = await fetch(`${url}/rest/v1/rpc/reminders_sent`, {
      method: 'POST',
      headers: { apikey: publishable, Authorization: `Bearer ${publishable}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_secret: secret, p_sent: [mine.subscription_id], p_gone: [] }),
    });
    const { data: after } = await supabase.from('push_subscriptions').select('last_sent_at').eq('endpoint', endpoint).maybeSingle();
    check(mark.ok && !!(after as { last_sent_at: string | null } | null)?.last_sent_at, `marked sent through reminders_sent (HTTP ${mark.status})`);
    const secondDry = dryRun();
    console.log(`dry run right after sending: ${secondDry}`);
    check(/[1-9]\d* skipped, reminded in the last 2 hours/.test(secondDry), 'the sender skips a device reminded in the last two hours');

    // 5. Off, from Settings.
    await page.click('Turn off reminders');
    await page.waitFor(`document.querySelector('#root').innerText.includes('Reminders are off') ? 'y' : ''`, 'reminders to turn off', 30_000);
    const { data: left } = await supabase.from('push_subscriptions').select('id').eq('endpoint', endpoint);
    const { data: offSettings } = await supabase.from('reminder_settings').select('slots').eq('user_id', uid).maybeSingle();
    const stillSubscribed = await page.evaluate<boolean>(
      `(async () => !!(await (await navigator.serviceWorker.ready).pushManager.getSubscription()))()`,
      true,
    );
    check(
      (left ?? []).length === 0 && ((offSettings as { slots: string[] } | null)?.slots ?? []).length === 0 && !stillSubscribed,
      `turned off from Settings: device rows ${(left ?? []).length}, times ${JSON.stringify((offSettings as { slots: string[] } | null)?.slots)}, browser still subscribed: ${stillSubscribed}`,
    );
  } finally {
    const errors = page.logs().filter((l) => l.startsWith('[exception]') || l.startsWith('[error]'));
    if (errors.length) console.log(`--- page errors ---\n${errors.slice(-10).join('\n')}`);
    await page.close();
    if (endpoint) await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    await supabase.from('reminder_settings').delete().eq('user_id', uid);
    console.log('cleaned up the test account\'s reminders');
  }

  for (const line of results) console.log(line);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
