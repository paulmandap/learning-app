import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest runs ONLY over framework-free code.
 *
 * Everything under src/core/** and src/ai/** is plain TypeScript with no
 * react-native / expo-* imports, so no native transform is needed here.
 * That separation is an architectural requirement (assessment §5.2), not a
 * convenience — it is what lets the spec's §7 test plan run with no network.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
