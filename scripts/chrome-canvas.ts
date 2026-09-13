/**
 * A blank headless Chrome page, for image work done with the browser's canvas.
 *
 * Extracted from `make-pet-assets.ts` when `make-nomi-assets.ts` became the
 * second script to need it. Two copies of the DevTools plumbing is exactly how
 * the two would drift — the same reason `LEVELS` stopped being declared three
 * times (NOTES §35).
 *
 * No dependency, for the reason the pet script gave: Chrome's canvas decodes,
 * composites and encodes WebP, and this project already drives Chrome for
 * screenshots. An image library would be a large addition for commands that run
 * a handful of times in the life of the project.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((p): p is string => typeof p === 'string');

export interface CanvasPage {
  /** Evaluate an expression in the page, awaiting it, and return its value. */
  evaluate<T>(expression: string): Promise<T>;
  close(): void;
}

export async function openCanvasPage(profile: string): Promise<CanvasPage> {
  const chrome: ChildProcess = spawn(
    CHROME_CANDIDATES.find((p) => existsSync(p)) ?? 'chrome',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `cdp-${profile}-${Date.now()}`)}`,
      'about:blank',
    ],
  );

  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('Chrome never reported a debug port')), 20_000);
    chrome.stderr?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = buffered.match(/ws:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve) => (ws.onopen = resolve));

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.onmessage = (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const raw = (method: string, params: unknown = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = (await raw('Target.createTarget', { url: 'about:blank' })) as {
    targetId: string;
  };
  const { sessionId } = (await raw('Target.attachToTarget', { targetId, flatten: true })) as {
    sessionId: string;
  };

  return {
    async evaluate<T>(expression: string): Promise<T> {
      const reply = (await raw(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )) as {
        result: { value: T };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      };
      // An exception inside the page is not a protocol error, so it arrives as
      // a normal reply with no value. Without this it surfaces later as a
      // baffling "cannot read properties of undefined" in the caller.
      if (reply.exceptionDetails) {
        const e = reply.exceptionDetails;
        throw new Error(`in page: ${e.exception?.description ?? e.text ?? 'unknown error'}`);
      }
      return reply.result.value;
    },
    close() {
      ws.close();
      chrome.kill();
    },
  };
}
