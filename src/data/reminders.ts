import { supabase } from './supabase';
import { isMissingTable } from '../core/db-errors';
import {
  base64UrlToBytes,
  cleanSlots,
  readSubscription,
  VAPID_PUBLIC_KEY,
  type ReminderSlot,
} from '../core/reminders';

/**
 * Daily reminders on this device (NOTES §45): turning them on, which times,
 * and turning them off.
 *
 * Web only, like the rest of the installed app. An iPhone shows a web app's
 * notifications only once it is on the Home Screen (iOS 16.4 and later), and
 * asks for permission only in answer to a tap — so `turnOnReminders` must be
 * called straight from one, with nothing awaited before it.
 *
 * What a reminder says is not decided here. The app records where to send them
 * and when; `scripts/send-reminders.ts` works out the rest.
 */

/** Reminders were used before migration 0020 was applied. */
export class RemindersUnavailableError extends Error {
  constructor() {
    super('Reminders are not switched on yet.');
    this.name = 'RemindersUnavailableError';
  }
}

/** A function the database has not got: PostgREST's PGRST202, Postgres's 42883. */
const isMissingFunction = (error: { code?: string } | null) =>
  !!error && (error.code === 'PGRST202' || error.code === '42883');

/**
 * Whether this device can get reminders.
 *
 *   ready        it can, and has not been refused permission
 *   install      an iPhone or iPad in Safari: Nomi must be on the Home Screen first
 *   unsupported  this browser cannot receive them
 *   blocked      notifications were refused, and only the device's settings can undo that
 */
export type ReminderSupport = 'ready' | 'install' | 'unsupported' | 'blocked';

export function reminderSupport(): ReminderSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  const apple =
    /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed =
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (apple && !installed) return 'install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return Notification.permission === 'denied' ? 'blocked' : 'ready';
}

async function thisDeviceSubscription(): Promise<PushSubscription | null> {
  const support = reminderSupport();
  if (support !== 'ready' && support !== 'blocked') return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return (await registration?.pushManager.getSubscription()) ?? null;
}

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

export interface ReminderSettings {
  /** The times chosen. Empty when reminders are off. */
  slots: ReminderSlot[];
  /** Whether this device is one they are sent to. */
  thisDevice: boolean;
}

/** Their reminders, or null before migration 0020. */
export async function fetchReminders(): Promise<ReminderSettings | null> {
  const { data, error } = await supabase.from('reminder_settings').select('slots').maybeSingle();
  if (isMissingTable(error)) return null;
  if (error) throw new Error(error.message);
  const slots = cleanSlots((data as { slots: unknown[] } | null)?.slots ?? []);

  const subscription = await thisDeviceSubscription().catch((err: unknown) => {
    console.warn(`[reminders] could not read this device's subscription: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  if (!subscription) return { slots, thisDevice: false };
  const { data: rows, error: rowError } = await supabase
    .from('push_subscriptions')
    .select('id')
    .eq('endpoint', subscription.endpoint)
    .limit(1);
  if (rowError) console.warn(`[reminders] could not check this device: ${rowError.message}`);
  return { slots, thisDevice: (rows ?? []).length > 0 };
}

/** Which times they want. Empty turns reminders off everywhere. */
export async function saveReminderSlots(slots: readonly ReminderSlot[]): Promise<void> {
  const user_id = await currentUserId();
  const { error } = await supabase
    .from('reminder_settings')
    .upsert({ user_id, slots: cleanSlots(slots), updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (isMissingTable(error)) throw new RemindersUnavailableError();
  if (error) throw new Error(error.message);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * This device's subscription under the app's key. One made under another key
 * — before a key was replaced — would be refused by the push service at every
 * send, so it is replaced rather than reused.
 */
async function subscribe(pushManager: PushManager): Promise<PushSubscription> {
  const key = base64UrlToBytes(VAPID_PUBLIC_KEY);
  const existing = await pushManager.getSubscription();
  const existingKey = existing?.options.applicationServerKey;
  if (existing && existingKey && sameBytes(new Uint8Array(existingKey), key)) return existing;
  if (existing) await existing.unsubscribe();
  return pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/**
 * Turn reminders on for this device, at these times.
 *
 * Call it straight from the tap. The permission question comes first, before
 * anything else is awaited, because an iPhone asks only in answer to a tap.
 */
export async function turnOnReminders(slots: readonly ReminderSlot[]): Promise<'on' | 'blocked'> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'blocked';

  await navigator.serviceWorker.register('/sw.js');
  const registration = await navigator.serviceWorker.ready;
  const keys = readSubscription((await subscribe(registration.pushManager)).toJSON());
  if (!keys) throw new Error('This browser gave an address reminders cannot be sent to.');

  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: keys.endpoint,
    p_p256dh: keys.p256dh,
    p_auth: keys.auth,
  });
  if (isMissingFunction(error)) throw new RemindersUnavailableError();
  if (error) throw new Error(error.message);
  await saveReminderSlots(slots);
  return 'on';
}

/**
 * This device stops getting reminders: its address is removed and the browser
 * forgets it. On turning reminders off, and on signing out — so the next
 * person on a shared phone is not shown someone else's due cards. Best effort.
 */
export async function forgetThisDevice(): Promise<void> {
  try {
    const subscription = await thisDeviceSubscription();
    if (!subscription) return;
    const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
    if (error && !isMissingTable(error)) console.warn(`[reminders] could not remove this device: ${error.message}`);
    await subscription.unsubscribe();
  } catch (err) {
    console.warn(`[reminders] could not forget this device: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Turn reminders off: no times chosen, so none go to any of their devices, and this device forgets its address. */
export async function turnOffReminders(): Promise<void> {
  await saveReminderSlots([]);
  await forgetThisDevice();
}
