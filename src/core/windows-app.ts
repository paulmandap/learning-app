/**
 * Whether Nomi is open in its Windows app rather than a browser (NOTES §73).
 *
 * The Windows app is a window that shows this same site (`src-tauri/`). Before
 * the site's own code runs, the window defines `window.nomiApp` as
 * `{ platform: 'windows' }`, on this site only. Nothing else sets it.
 *
 * What differs there: Microsoft's WebView2, which draws the window, has no
 * push at all, so reminders cannot reach it.
 *
 * Pure: it is handed the page's `window`, so a test can hand it anything.
 */

/** The name the window gives its mark. `src-tauri/src/main.rs` writes it. */
export const APP_MARK = 'nomiApp';

export function isWindowsApp(page: unknown): boolean {
  if (typeof page !== 'object' || page === null) return false;
  const mark: unknown = (page as Record<string, unknown>)[APP_MARK];
  return typeof mark === 'object' && mark !== null && (mark as { platform?: unknown }).platform === 'windows';
}
