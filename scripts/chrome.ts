/**
 * Headless Chrome for the scripts: found, started with a profile folder of its
 * own, and — the reason this file exists — that folder deleted once Chrome has
 * gone.
 *
 * The three places that start Chrome (`screenshot.ts`, `chrome-canvas.ts`,
 * `large-file-probe.ts`) each made `%TEMP%\cdp-<time>` and only `kill()`ed
 * Chrome at the end, so every run left its profile behind: about 575 files and
 * 19 MB. 187 of them made the owner's Windows sign-in take 50 seconds — the
 * User Profile Service walks `%TEMP%` at every logon, measured from the boot
 * trace on 2026-09-30. Three copies of the start-up code was how all three
 * leaked the same way; now there is one.
 *
 * ## One folder per Chrome, not one shared
 *
 * Two Chromes cannot use one profile at once — the second hands itself to the
 * first and quits — and a probe can hold two pages open, or start the next
 * before the last has quite exited. So each gets a fresh folder, named
 * `learning-app-chrome-…` so that nothing here ever touches anybody else's.
 *
 * ## Deleted three ways
 *
 * - `close()`: stop Chrome, wait for it to exit, then delete the folder —
 *   retrying, because Windows keeps a dead Chrome's files locked for a moment.
 * - On the way out of the process, however it ends — an error nobody caught,
 *   `process.exit`, Ctrl+C — every Chrome still open is stopped and its folder
 *   deleted.
 * - A run killed outright gets neither, so the next Chrome to start deletes
 *   any of these folders an hour old or more.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p): p is string => typeof p === 'string');

/** Every profile folder starts with this, so the sweep only ever touches ours. */
export const PROFILE_PREFIX = 'learning-app-chrome-';

/** A folder this old is from a run that is gone: nothing here runs for an hour. */
const STALE_MS = 60 * 60 * 1000;

/** How long Chrome gets to exit after it is told to, before its folder goes anyway. */
const EXIT_WAIT_MS = 5_000;

/** How long Chrome gets to say where its DevTools are. */
const START_WAIT_MS = 20_000;

/**
 * Windows holds a dead Chrome's files for a moment after it exits — its helper
 * processes close last — so a delete right away can meet EBUSY or EPERM. Node
 * retries those with a growing wait: 0.1 s, 0.2 s … about 5.5 s at most.
 */
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;

export function findChrome(): string {
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `No Chrome or Edge found. Looked in:\n  ${CANDIDATES.join('\n  ')}\n` + 'Set CHROME_PATH to point at one.',
    );
  }
  return found;
}

export interface Chrome {
  /** Where to connect to it over the DevTools Protocol. */
  wsUrl: string;
  /** Stop Chrome, wait for it to exit, and delete its profile folder. Safe to call twice. */
  close(): Promise<void>;
}

/** Every Chrome still running, and its folder — for the way out of the process. */
const running = new Set<{ process: ChildProcess; profile: string }>();

/**
 * Start a headless Chrome on a blank page, with a profile folder of its own.
 * `args` are added to the usual ones (`--window-size=…`); `label` goes in the
 * folder's name, to tell one script's from another's while it runs.
 */
export async function launchChrome(args: readonly string[] = [], label = ''): Promise<Chrome> {
  sweepStaleProfiles();
  cleanUpOnExit();

  const profile = mkdtempSync(join(tmpdir(), `${PROFILE_PREFIX}${label ? `${label}-` : ''}`));
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      // Port 0: the OS picks one, and Chrome says which on stderr.
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      ...args,
      'about:blank',
    ],
    // Only stderr is read. A stdout pipe nobody drains can fill and stall Chrome.
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const entry = { process: chrome, profile };
  running.add(entry);

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      await stop(chrome);
      try {
        await rm(profile, RM);
      } catch (err) {
        // Said, not swallowed: a folder left behind is how this file came to exist.
        console.warn(`[chrome] could not delete ${profile}: ${err instanceof Error ? err.message : String(err)}`);
      }
      running.delete(entry);
    })());

  try {
    return { wsUrl: await devToolsUrl(chrome), close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Chrome prints its DevTools endpoint on stderr once it is listening. */
function devToolsUrl(chrome: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const fail = (why: string) => {
      clearTimeout(timer);
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail('Chrome never reported a debug port'), START_WAIT_MS);
    chrome.once('error', (err) => fail(`Chrome did not start: ${err.message}`));
    chrome.once('exit', (code) => fail(`Chrome exited before it was ready (code ${code})`));
    chrome.stderr?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = buffered.match(/ws:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
}

/** Stop Chrome and wait until it has actually exited — or `EXIT_WAIT_MS`, whichever is first. */
function stop(chrome: ChildProcess): Promise<void> {
  if (chrome.exitCode !== null || chrome.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    // The timer is cleared on exit, so a quick exit does not hold the script
    // open for the rest of the wait.
    const timer = setTimeout(resolve, EXIT_WAIT_MS);
    chrome.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    chrome.kill();
  });
}

let exitHooked = false;

/**
 * However the script ends, no Chrome and no folder is left behind. 'exit'
 * handlers must be synchronous, so this kills and deletes synchronously —
 * `rmSync` retries a locked file the same way `rm` does.
 *
 * Ctrl+C and a terminate request do not emit 'exit' on their own: they are
 * turned into an exit (130 and 143, the codes a shell would report), which does.
 */
function cleanUpOnExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => {
    for (const { process: chrome, profile } of running) {
      try {
        chrome.kill();
      } catch {
        // Already gone.
      }
      try {
        rmSync(profile, RM);
      } catch (err) {
        console.warn(`[chrome] could not delete ${profile}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
}

let swept = false;

/**
 * Delete this project's profile folders left by a run that never got to clean
 * up — killed from Task Manager, a machine that slept. Only folders an hour old
 * or more: a younger one may belong to a script running right now.
 */
function sweepStaleProfiles(): void {
  if (swept) return;
  swept = true;
  const dir = tmpdir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const path = join(dir, name);
    try {
      if (Date.now() - statSync(path).mtimeMs < STALE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      console.warn(`[chrome] deleted a profile folder an earlier run left behind: ${name}`);
    } catch (err) {
      console.warn(`[chrome] could not delete ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
