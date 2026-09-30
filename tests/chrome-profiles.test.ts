import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Chrome's profile folders are deleted (NOTES §70).
 *
 * Every script that started Chrome made `%TEMP%\cdp-<time>` and only killed
 * Chrome, leaving ~575 files a run; 187 of those folders made the owner's
 * Windows sign-in take 50 s. Starting Chrome now happens in one place,
 * `scripts/chrome.ts`, which deletes the folder — these hold it there.
 */

const scripts = readdirSync('scripts').filter((f) => f.endsWith('.ts'));
const read = (f: string) => readFileSync(join('scripts', f), 'utf8');

describe('Chrome profile folders', () => {
  it('only scripts/chrome.ts starts Chrome or names a profile folder', () => {
    for (const f of scripts) {
      if (f === 'chrome.ts') continue;
      const src = read(f);
      expect(src, f).not.toContain('--user-data-dir');
      expect(src, f).not.toMatch(/spawn\([^)]*[Cc]hrome/);
    }
  });

  it('closing waits for Chrome to exit, then deletes the folder, retrying while Windows holds it', () => {
    const chrome = read('chrome.ts');
    expect(chrome).toMatch(/await stop\(chrome\);\s*try \{\s*await rm\(profile, RM\);/);
    expect(chrome).toContain('maxRetries: 10');
  });

  it('a script that ends any other way still deletes it, and the next run sweeps what a kill left', () => {
    const chrome = read('chrome.ts');
    expect(chrome).toContain("process.once('exit'");
    expect(chrome).toContain("process.once('SIGINT', () => process.exit(130));");
    expect(chrome).toContain('function sweepStaleProfiles');
    expect(chrome).toContain("export const PROFILE_PREFIX = 'learning-app-chrome-';");
  });

  it('a page whose setup fails closes its own Chrome — nobody else holds it', () => {
    const screenshot = read('screenshot.ts');
    expect(screenshot).toMatch(/return await setUp\(options, started\);\s*\} catch \(err\) \{[\s\S]*?await started\.chrome\?\.close\(\);/);
  });

  it('every caller waits for the close', () => {
    for (const f of ['make-icons.ts', 'make-nomi-assets.ts', 'make-nomi-props.ts', 'make-pet-assets.ts']) {
      expect(read(f), f).toContain('await page.close();');
    }
  });
});
