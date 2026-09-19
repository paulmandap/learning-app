/**
 * Send the study reminders for one time of day (NOTES §45).
 *
 *   npx tsx scripts/send-reminders.ts --slot evening [--dry-run]
 *
 * Run by .github/workflows/reminders.yml three times a day. Needs
 * SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or the EXPO_PUBLIC_ pair in .env),
 * REMINDER_SENDER_SECRET and VAPID_PRIVATE_KEY.
 *
 * Reaches the database only through reminders_to_send() and reminders_sent()
 * (migration 0020), with the publishable key and the sender's secret — no
 * service-role key and no database password. What each reminder says is
 * decided in src/core/reminders.ts.
 *
 * Prints counts and nothing else: no person, no address, no number from anyone's
 * studying. The log of a public repository's workflow is public.
 */
import { sendPush, type VapidKeys } from './web-push';
import { CONTACT_EMAIL } from '../src/core/legal';
import {
  isReminderSlot,
  REMINDER_TTL_SECONDS,
  reminderCounts,
  reminderMessage,
  reminderPayload,
  REMINDER_TOPIC,
  sentRecently,
  VAPID_PUBLIC_KEY,
} from '../src/core/reminders';

/**
 * Say it where the failure email will show it.
 *
 * GitHub puts `::error::` lines in a run's annotations, and the annotations are
 * in the email it sends when a run fails. Without this the email says only
 * "All jobs have failed" and the reason is behind a sign-in and four clicks —
 * which is how a plain 400 from Apple went unread for eight days (NOTES §47).
 */
function reportFailure(message: string): void {
  console.warn(`  ${message}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${message}`);
}

interface Device {
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  last_sent_at: string | null;
  study_days: string[];
  due_at: string[];
}

function required(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  console.error(`Set ${names.join(' or ')}.`);
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const slot = args[args.indexOf('--slot') + 1];
  if (!args.includes('--slot') || !isReminderSlot(slot)) {
    console.error('Pass --slot morning, afternoon or evening.');
    process.exit(2);
  }
  const dryRun = args.includes('--dry-run');

  const url = required('SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_URL');
  const publishable = required('SUPABASE_PUBLISHABLE_KEY', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const secret = required('REMINDER_SENDER_SECRET');
  const keys: VapidKeys = { publicKey: VAPID_PUBLIC_KEY, privateKey: required('VAPID_PRIVATE_KEY') };

  const rpc = async <T>(name: string, body: object): Promise<T> => {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: publishable, Authorization: `Bearer ${publishable}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    // A refusal says why — "not allowed" is a wrong secret, a missing function is 0020 not applied.
    if (!response.ok) throw new Error(`${name} answered HTTP ${response.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  };

  const now = Date.now();
  const devices = await rpc<Device[]>('reminders_to_send', { p_secret: secret, p_slot: slot });
  const tally = { sent: 0, studied: 0, recent: 0, gone: 0, failed: 0 };
  const sent: string[] = [];
  const gone: string[] = [];

  for (const device of devices) {
    if (sentRecently(device.last_sent_at, now)) {
      tally.recent++;
      continue;
    }
    const reminder = reminderMessage(reminderCounts({ studyDays: device.study_days, dueAt: device.due_at }, now));
    if (!reminder) {
      tally.studied++;
      continue;
    }
    if (dryRun) {
      tally.sent++;
      continue;
    }
    try {
      const result = await sendPush(device, reminderPayload(reminder), {
        keys,
        subject: `mailto:${CONTACT_EMAIL}`,
        ttlSeconds: REMINDER_TTL_SECONDS,
        topic: REMINDER_TOPIC,
        now,
      });
      if (result.outcome === 'sent') {
        tally.sent++;
        sent.push(device.subscription_id);
      } else if (result.outcome === 'gone') {
        tally.gone++;
        gone.push(device.subscription_id);
      } else {
        tally.failed++;
        // The service's host and its answer, never the address itself.
        reportFailure(`not sent: ${new URL(device.endpoint).host} answered HTTP ${result.status} ${result.detail}`);
      }
    } catch (err) {
      tally.failed++;
      reportFailure(`not sent: ${new URL(device.endpoint).host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (sent.length > 0 || gone.length > 0) {
    await rpc('reminders_sent', { p_secret: secret, p_sent: sent, p_gone: gone });
  }

  console.log(
    `${slot}${dryRun ? ' (dry run — nothing sent)' : ''}: ${devices.length} device(s) · ` +
      `${tally.sent} ${dryRun ? 'would be sent' : 'sent'} · ${tally.studied} skipped, studied today · ` +
      `${tally.recent} skipped, reminded in the last 2 hours · ${tally.gone} gone · ${tally.failed} failed`,
  );
  if (tally.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
