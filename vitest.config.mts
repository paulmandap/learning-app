import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest runs ONLY over framework-free code.
 *
 * Everything under src/core/**, src/ai/** and src/data/** is plain TypeScript
 * with no react-native / expo-* imports, so no native transform is needed here.
 * That separation is an architectural requirement (assessment §5.2), not a
 * convenience — it is what lets the spec's §7 test plan run with no network.
 *
 * src/data/** joined that list in Phase B. It was always framework-free; it was
 * excluded by convention rather than by any technical barrier, and the cost of
 * that convention was that `fetchDashboard`, `recordAttempt` and every other
 * query lived where no test could reach them. A dashboard button wired to the
 * wrong route shipped and stayed shipped for exactly that reason.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * src/data/supabase.ts THROWS AT IMPORT without these.
     *
     * That fail-fast is right in production — a build with no database
     * configured should stop rather than render an app that cannot load
     * anything — so it stays, and the test run satisfies it instead.
     *
     * Deliberately fake. Nothing in the suite may reach the network: every
     * test drives the data layer through an injected client whose fetch is a
     * stub. A request that escapes the stub goes to a host that does not
     * exist and fails loudly, which is the behaviour we want from a leak.
     */
    env: {
      EXPO_PUBLIC_SUPABASE_URL: 'https://test-stub.supabase.co',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_stub',
    },
    // The default worker pool crashes on Windows with this many files
    // ("Cannot read properties of undefined (reading 'config')"). Forks are
    // slightly slower to start and actually work.
    pool: 'forks',
    // Live Gemini tests opt in via LIVE_GEMINI=1; they are never required.
    exclude: ['node_modules/**', 'dist/**'],
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
