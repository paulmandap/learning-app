import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALL_SLOTS,
  base64UrlToBytes,
  cleanSlots,
  nextReminder,
  readSubscription,
  REMINDER_TIMES,
  reminderCounts,
  reminderMessage,
  reminderPayload,
  sentRecently,
  slotForCron,
  VAPID_PUBLIC_KEY,
} from '../src/core/reminders';

/**
 * Daily study reminders (NOTES §45): when they come, what they say, and that
 * the app, the workflow that sends them and the database agree on both.
 */

const at = (iso: string) => Date.parse(iso);
const workflow = readFileSync('.github/workflows/reminders.yml', 'utf8');
const migration = readFileSync('supabase/migrations/0020_reminders.sql', 'utf8');

describe('when reminders come', () => {
  it('three a day at most — the owner asked for no more', () => {
    expect(REMINDER_TIMES).toHaveLength(3);
  });

  it('each runs at its Philippine hour in UTC, seven minutes past', () => {
    for (const time of REMINDER_TIMES) {
      const [minute, hour] = time.cron.split(' ');
      expect(Number(minute), time.slot).toBe(7);
      expect((Number(hour) + 8) % 24, time.slot).toBe(time.hour);
      expect(slotForCron(time.cron)).toBe(time.slot);
    }
    expect(slotForCron('0 0 * * *')).toBeNull();
  });

  it('the workflow runs at exactly these times, and sends each one its own reminder', () => {
    const crons = [...workflow.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);
    expect(crons).toEqual(REMINDER_TIMES.map((t) => t.cron));
    for (const time of REMINDER_TIMES) expect(workflow).toContain(`'${time.cron}') slot=${time.slot} ;;`);
  });

  it('the database takes exactly these times', () => {
    expect(migration).toContain(`slots <@ array[${ALL_SLOTS.map((s) => `'${s}'`).join(', ')}]::text[]`);
  });

  it('keeps chosen times known, once each, in the order of the day', () => {
    expect(cleanSlots(['evening', 'morning', 'evening', 'midnight', 3])).toEqual(['morning', 'evening']);
  });

  it('knows which comes next, in Philippine time', () => {
    const tenInTheMorning = at('2026-09-15T02:00:00Z');
    expect(nextReminder(ALL_SLOTS, tenInTheMorning)?.slot).toBe('afternoon');
    expect(nextReminder(['morning'], tenInTheMorning)?.label).toBe('9 AM'); // tomorrow's
    expect(nextReminder(['evening'], at('2026-09-15T12:06:00Z'))?.slot).toBe('evening');
    expect(nextReminder([], tenInTheMorning)).toBeNull();
  });
});

describe('what a reminder says', () => {
  const eightInTheEvening = at('2026-09-15T12:07:00Z');

  it("counts as Home does: the streak, today, and cards due by the start of today", () => {
    const counts = reminderCounts(
      {
        studyDays: ['2026-09-14', '2026-09-13', '2026-09-11'],
        dueAt: ['2026-09-15T00:00:00Z', '2026-09-14T09:00:00+00:00', '2026-09-15T08:00:00Z'],
      },
      eightInTheEvening,
    );
    expect(counts).toEqual({ streak: 2, studiedToday: false, due: 2 });
    expect(reminderCounts({ studyDays: ['2026-09-15'], dueAt: [] }, eightInTheEvening).studiedToday).toBe(true);
  });

  it("says what's waiting, and the streak when there is one to keep", () => {
    expect(reminderMessage({ due: 8, streak: 3, studiedToday: false })).toEqual({
      title: '8 cards due today',
      body: 'Keep your 3-day streak going.',
    });
    expect(reminderMessage({ due: 1, streak: 0, studiedToday: false })).toEqual({
      title: '1 card due today',
      body: 'A few minutes now keeps them fresh.',
    });
    expect(reminderMessage({ due: 0, streak: 5, studiedToday: false })).toEqual({
      title: 'Studied yet today?',
      body: 'Keep your 5-day streak going.',
    });
    expect(reminderMessage({ due: 0, streak: 0, studiedToday: false })).toEqual({
      title: 'Studied yet today?',
      body: "Nomi's ready when you are.",
    });
  });

  it('sends nothing once they have studied today', () => {
    expect(reminderMessage({ due: 8, streak: 3, studiedToday: true })).toBeNull();
  });

  it('opens Nomi when tapped', () => {
    expect(JSON.parse(reminderPayload({ title: 'a', body: 'b' }))).toEqual({ title: 'a', body: 'b', url: '/' });
  });

  it('never sends a second within two hours of the last', () => {
    expect(sentRecently(null, eightInTheEvening)).toBe(false);
    expect(sentRecently('2026-09-15T11:00:00Z', eightInTheEvening)).toBe(true);
    expect(sentRecently('2026-09-15T07:07:00Z', eightInTheEvening)).toBe(false);
  });
});

describe("a device's address", () => {
  const auth = 'BTBZMqHH6r4Tts7J_aSIgg';

  it('keeps what the sender needs, as base64url without padding, however the browser wrote it', () => {
    const endpoint = 'https://web.push.apple.com/QGh5/abc';
    expect(readSubscription({ endpoint, keys: { p256dh: VAPID_PUBLIC_KEY, auth } })).toEqual({
      endpoint,
      p256dh: VAPID_PUBLIC_KEY,
      auth,
    });
    const padded = { p256dh: `${VAPID_PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/')}=`, auth: `${auth}==` };
    expect(readSubscription({ endpoint, keys: padded })).toMatchObject({ p256dh: VAPID_PUBLIC_KEY, auth });
  });

  it('refuses anything that is not one', () => {
    for (const bad of [
      null,
      {},
      { endpoint: 'http://push.example.test/a', keys: { p256dh: VAPID_PUBLIC_KEY, auth } },
      { endpoint: 'https://push.example.test/a', keys: { p256dh: 'short', auth } },
      { endpoint: 'https://push.example.test/a', keys: { p256dh: VAPID_PUBLIC_KEY } },
    ]) {
      expect(readSubscription(bad)).toBeNull();
    }
  });

  it('the database takes exactly the keys this reads', () => {
    expect(migration).toContain("p256dh ~ '^[A-Za-z0-9_-]{87}$'");
    expect(migration).toContain("auth ~ '^[A-Za-z0-9_-]{22}$'");
  });

  it("the app's key is the 65-byte public key a browser subscribes with", () => {
    const key = base64UrlToBytes(VAPID_PUBLIC_KEY);
    expect(key).toHaveLength(65);
    expect(key[0]).toBe(4);
  });
});

describe('the sender reaches only what it needs', () => {
  it('uses the publishable key and its own secret — never a service-role key or the database password', () => {
    expect(workflow).not.toMatch(/service_role|SERVICE_ROLE|SUPABASE_DB_URL/);
    expect(readFileSync('scripts/send-reminders.ts', 'utf8')).not.toMatch(/service_role|SERVICE_ROLE|SUPABASE_DB_URL/);
  });

  it('opens its two functions to the publishable key only, behind the secret', () => {
    expect(migration).toContain('grant execute on function public.reminders_to_send(text, text) to anon;');
    expect(migration).toContain('grant execute on function public.reminders_sent(text, uuid[], uuid[]) to anon;');
    expect(migration).not.toMatch(/reminders_to_send\(text, text\) to [^;]*authenticated/);
    const guarded = migration.match(/reminder_sender_allowed\(p_secret\)/g) ?? [];
    expect(guarded).toHaveLength(2);
  });
});
