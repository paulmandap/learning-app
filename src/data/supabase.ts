import { createClient } from '@supabase/supabase-js';

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
