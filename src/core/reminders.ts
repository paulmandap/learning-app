/**
 * Daily study reminders: when they come, what they say, and whether one goes
 * (NOTES §45).
 *
 * Pure. Settings reads the times from here, and `scripts/send-reminders.ts` —
 * run by `.github/workflows/reminders.yml` — reads everything else, so what a
 * reminder says is worked out by the same rules as what Home says.
 *
 * ## What the owner asked for
 *
 * *"add daily notification like reminding the user about their backlogs, study
 * yet?, or a simple reminder about studying."* Asked how it should reach them:
 * a phone notification. What it should say: what's waiting. How often: *"ideal
 * would be a max of 3 per day"* — so three times a day, each one a person can
 * turn off, none once they have studied that day, and each one replacing the
 * last on the lock screen rather than piling up.
 */

import { studyStreak } from './progress';
import { startOfUtcDay } from './schedule';

export type ReminderSlot = 'morning' | 'afternoon' | 'evening';

export interface ReminderTime {
  slot: ReminderSlot;
  /** As Settings says it. */
  label: string;
  /** The hour in the Philippines, UTC+8 all year. */
  hour: number;
  /** When the workflow runs for it, in UTC — listed again in `.github/workflows/reminders.yml`. */
  cron: string;
}

/**
 * Three a day at most, in Philippine time: Nomi is run from the Philippines for
 * people there (Privacy Policy), and with no daylight saving one UTC schedule
 * is right all year. Seven minutes past the hour, because GitHub's scheduler is
 * busiest on the hour and runs late there.
 */
export const REMINDER_TIMES: readonly ReminderTime[] = [
  { slot: 'morning', label: '9 AM', hour: 9, cron: '7 1 * * *' },
  { slot: 'afternoon', label: '3 PM', hour: 15, cron: '7 7 * * *' },
  { slot: 'evening', label: '8 PM', hour: 20, cron: '7 12 * * *' },
];

/** Hours the Philippines is ahead of UTC. */
const PH_OFFSET_HOURS = 8;

export const ALL_SLOTS: readonly ReminderSlot[] = REMINDER_TIMES.map((t) => t.slot);

export function isReminderSlot(value: unknown): value is ReminderSlot {
  return typeof value === 'string' && (ALL_SLOTS as readonly string[]).includes(value);
}

/** Slots as they are stored: known ones only, once each, in the order of the day. */
export function cleanSlots(slots: readonly unknown[]): ReminderSlot[] {
  return ALL_SLOTS.filter((slot) => slots.includes(slot));
}

/** The time of day a scheduled run is for, from the schedule that started it. */
export function slotForCron(cron: string): ReminderSlot | null {
  return REMINDER_TIMES.find((t) => t.cron === cron.trim())?.slot ?? null;
}

/** The next reminder a person will get, or null when none are chosen. */
export function nextReminder(slots: readonly ReminderSlot[], now: number): ReminderTime | null {
  const chosen = REMINDER_TIMES.filter((t) => slots.includes(t.slot));
  if (chosen.length === 0) return null;
  const date = new Date(now + PH_OFFSET_HOURS * 60 * 60 * 1000);
  const minutesNow = date.getUTCHours() * 60 + date.getUTCMinutes();
  return chosen.find((t) => t.hour * 60 + 7 > minutesNow) ?? chosen[0]!;
}

// ------------------------------------------------------------ what it says --

/** What the sender reads for one person. */
export interface ReminderFacts {
  /** The days they studied, as `study_days` stores them: "2026-09-15". */
  studyDays: readonly string[];
  /** When each card they could be dealt is next due. */
  dueAt: readonly string[];
}

export interface ReminderCounts {
  streak: number;
  studiedToday: boolean;
  due: number;
}

/**
 * The numbers Home shows, by Home's rules (`fetchDashboard`): the streak and
 * "today" from `study_days` on UTC days, and due as a card on the schedule
 * whose due time has come by the start of today. The database has already left
 * out cards that are hidden, as the dashboard does.
 */
export function reminderCounts(facts: ReminderFacts, now: number): ReminderCounts {
  const days = facts.studyDays.map((day) => Date.parse(`${day}T00:00:00Z`)).filter(Number.isFinite);
  const today = startOfUtcDay(now);
  return {
    streak: studyStreak(days, now),
    studiedToday: days.some((t) => startOfUtcDay(t) === today),
    due: facts.dueAt.filter((at) => Date.parse(at) <= today).length,
  };
}

export interface Reminder {
  title: string;
  body: string;
}

/**
 * What a reminder says — or null, and none is sent, once they have studied
 * today. Only numbers that are true, and a streak only when there is one to
 * keep.
 */
export function reminderMessage(counts: ReminderCounts): Reminder | null {
  if (counts.studiedToday) return null;
  const keepStreak = counts.streak > 0 ? `Keep your ${counts.streak}-day streak going.` : null;
  if (counts.due > 0) {
    return {
      title: `${counts.due} card${counts.due === 1 ? '' : 's'} due today`,
      body: keepStreak ?? 'A few minutes now keeps them fresh.',
    };
  }
  return { title: 'Studied yet today?', body: keepStreak ?? "Nomi's ready when you are." };
}

/** What the service worker is sent: a reminder, and where tapping it goes. */
export function reminderPayload(reminder: Reminder): string {
  return JSON.stringify({ title: reminder.title, body: reminder.body, url: '/' });
}

/**
 * No second reminder within this long of the last, however the workflow was
 * started — a run by hand just after a scheduled one sends nothing twice. The
 * times are six hours apart.
 */
export const MIN_HOURS_BETWEEN_REMINDERS = 2;

export function sentRecently(lastSentAt: string | null, now: number): boolean {
  if (!lastSentAt) return false;
  const at = Date.parse(lastSentAt);
  return Number.isFinite(at) && now - at < MIN_HOURS_BETWEEN_REMINDERS * 60 * 60 * 1000;
}

/**
 * How long a push service keeps trying a phone that is off: until shortly
 * before the next time, so a morning reminder does not arrive in the evening.
 */
export const REMINDER_TTL_SECONDS = 3 * 60 * 60;

// ---------------------------------------------------------------- the keys --

/**
 * The key a device subscribes with — the public half of the key every reminder
 * is signed with. The private half is the `VAPID_PRIVATE_KEY` secret. Replacing
 * this means every device has to turn reminders on again.
 */
export const VAPID_PUBLIC_KEY = 'BF-1GlLBP88ZNxMzw5wSl7iNemlomOpJMXbPMZRqMlbWCucSQQhkwkszZ67jvKGk7RXPUcHmcJuHq5XeWJ92wvA';

/** A base64url string as bytes — `pushManager.subscribe` wants the key this way. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface SubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * The parts of a browser's push subscription the sender needs, or null when it
 * is not one. Keys are kept as base64url without padding, whichever way the
 * browser wrote them; the sizes are the standard's — a 65-byte public key and a
 * 16-byte secret.
 */
export function readSubscription(json: unknown): SubscriptionKeys | null {
  const s = json as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!s || typeof s.endpoint !== 'string' || !/^https:\/\/\S+$/.test(s.endpoint) || s.endpoint.length > 1000) return null;
  const clean = (v: unknown) =>
    typeof v === 'string' ? v.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '';
  const p256dh = clean(s.keys?.p256dh);
  const auth = clean(s.keys?.auth);
  if (!/^[A-Za-z0-9_-]{87}$/.test(p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(auth)) return null;
  return { endpoint: s.endpoint, p256dh, auth };
}
