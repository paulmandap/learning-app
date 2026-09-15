/**
 * Does a reminder actually arrive? (NOTES §45)
 *
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/push-probe.ts
 *
 * The encryption and the signature are tested against their standards with no
 * network (tests/web-push.test.ts). This is the other half: headless Chrome
 * opens the built app, registers public/sw.js and subscribes with the app's
 * key, exactly as Settings does; then scripts/web-push.ts sends it a reminder
 * through Google's real push service, signed with VAPID_PRIVATE_KEY from .env;
 * and the probe waits for the service worker to show it.
 *
 * Needs no database and no migration — nothing is saved anywhere. What it
 * cannot reach is Apple's push service, which only an iPhone subscribes to.
 */
import { openPage } from './screenshot';
import { sendPush } from './web-push';
import { CONTACT_EMAIL } from '../src/core/legal';
import { readSubscription, reminderMessage, reminderPayload, VAPID_PUBLIC_KEY } from '../src/core/reminders';

async function main() {
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!privateKey) throw new Error('Set VAPID_PRIVATE_KEY (it is in .env).');

  const page = await openPage({ auth: false, width: 393, height: 852 });
  try {
    await page.browser('Browser.grantPermissions', { origin: page.origin, permissions: ['notifications'] });

    const subscribed = await page.evaluate<string>(
      `(async () => {
        try {
          const key = ${JSON.stringify(VAPID_PUBLIC_KEY)};
          const base64 = key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4);
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          await navigator.serviceWorker.register('/sw.js');
          const registration = await navigator.serviceWorker.ready;
          const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
          return JSON.stringify(subscription.toJSON());
        } catch (err) {
          return 'error: ' + (err && err.message ? err.message : String(err));
        }
      })()`,
      true,
    );
    if (subscribed.startsWith('error:')) throw new Error(`Chrome would not subscribe — ${subscribed}`);

    const device = readSubscription(JSON.parse(subscribed));
    if (!device) throw new Error(`Not a subscription the app can use: ${subscribed.slice(0, 120)}`);
    console.log(`subscribed at ${new URL(device.endpoint).host}`);

    const before = await page.evaluate<number>(
      `(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length)()`,
      true,
    );
    if (before !== 0) throw new Error(`${before} notification(s) already showing — the check below would prove nothing`);

    const reminder = reminderMessage({ due: 8, streak: 3, studiedToday: false })!;
    const result = await sendPush(device, reminderPayload(reminder), {
      keys: { publicKey: VAPID_PUBLIC_KEY, privateKey },
      subject: `mailto:${CONTACT_EMAIL}`,
      ttlSeconds: 60,
      topic: 'nomi-reminder',
    });
    console.log(`push service answered HTTP ${result.status} (${result.outcome})${result.detail ? `: ${result.detail}` : ''}`);
    if (result.outcome !== 'sent') throw new Error('The push service did not accept the reminder.');

    // waitFor reads a plain value. Handed an async function it gets a Promise,
    // which is truthy, and "passed" at once without looking — the first run of
    // this probe did exactly that. So the page looks, and leaves what it saw.
    await page.evaluate(`(() => {
      window.__shown = '';
      const look = async () => {
        const shown = await (await navigator.serviceWorker.ready).getNotifications({ tag: 'nomi-reminder' });
        if (shown.length) window.__shown = JSON.stringify({ title: shown[0].title, body: shown[0].body, url: shown[0].data && shown[0].data.url });
        else setTimeout(look, 250);
      };
      look();
    })()`);
    const shown = await page.waitFor<string>(`window.__shown`, 'the reminder to be shown', 30_000);
    const expected = JSON.stringify({ title: reminder.title, body: reminder.body, url: '/' });
    console.log(`shown by the service worker: ${shown}`);
    if (shown !== expected) throw new Error(`Expected ${expected}`);

    await page.evaluate(
      `(async () => {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe();
        for (const n of await registration.getNotifications()) n.close();
      })()`,
      true,
    );
    console.log('unsubscribed. OK');
  } finally {
    await page.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
