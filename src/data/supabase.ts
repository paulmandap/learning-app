import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client.
 *
 * Uses the PUBLISHABLE (client) key only. That key is safe in shipped code
 * because it reaches only what RLS allows — the database, not the key, is the
 * authorisation boundary. A secret/service-role key bypasses RLS entirely and
 * must never appear in this app.
 *
 * Session persistence uses the platform's default web storage. The MVP ships
 * as a web app / iOS PWA, so localStorage is the real storage everywhere it
 * runs; a native build would need an explicit AsyncStorage adapter here.
 */

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  throw new Error(
    'Supabase is not configured. Copy .env.example to .env and fill in ' +
      'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
  );
}

/**
 * The client a data function talks to — the test seam for `src/data/**`.
 *
 * ## Why this exists
 *
 * Until Phase B nothing under `src/data/**` had a single test, and the reason
 * was not that it imports react-native (it does not) but that every function
 * reached straight for the module singleton below. A dashboard button wired to
 * the wrong route shipped and stayed shipped because no test could reach the
 * function that built it.
 *
 * ## How it is used
 *
 * Every seam-carrying function takes the client as an OPTIONAL trailing
 * parameter defaulting to `supabase`:
 *
 * ```ts
 * export async function dueCountsBySet(now = Date.now(), db: Db = supabase) { … }
 * ```
 *
 * So no caller changes, anywhere. The app keeps calling `dueCountsBySet()` and
 * gets the real client; a test passes one built over a stubbed `fetch`.
 *
 * ## Why a whole client rather than a hand-written mock
 *
 * `createClient(url, key, { global: { fetch } })` routes PostgREST, Auth, RPC
 * and Storage through one injected fetch — the same `fetchImpl` seam
 * `GeminiBrowserProvider` already uses. A test therefore exercises the REAL
 * query builder and asserts on the URL it produces.
 *
 * That matters more here than it sounds. `dueCountsBySet` filters on an
 * embedded relationship, and NOTES §21.1 records that an embedded filter which
 * fails to resolve returns rows rather than an error — a silent wrong answer. A
 * hand-written builder mock would happily agree with whatever the code asked
 * for; a URL assertion catches it.
 */
export type Db = SupabaseClient;

export const supabase = createClient(url, publishableKey, {
  auth: {
    // OTP only (D10): no passwords, no magic links. detectSessionInUrl is off
    // because we never round-trip through an email link — the six-digit code
    // is typed into the app, so the session is created in the page that asked
    // for it. This is what makes an installed PWA work at all.
    detectSessionInUrl: false,
    persistSession: true,
    autoRefreshToken: true,
    flowType: 'implicit',
  },
});
