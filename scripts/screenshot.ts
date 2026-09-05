/**
 * Look at the built app, on a real route, signed in.
 *
 * Typecheck and the test suite have now missed three UI defects in a row: a
 * diagram cropped to its top band, an image that collapsed to nothing, and a
 * header that read "set/[id]/blanks" to the user. All three were obvious the
 * moment someone looked. This is how you look, without a browser open.
 *
 * Serves `dist/` with the SPA fallback that `public/_redirects` provides in
 * production, injects a Supabase session the way the app itself stores one,
 * then drives headless Chrome over the DevTools Protocol.
 *
 * NO DEPENDENCIES, deliberately. Node 22 ships a global WebSocket and Chrome
 * ships the protocol; Playwright or Puppeteer would be a large dependency for a
 * five-user project, and this file is the whole of what they would be used for.
 *
 * Run (build first — this reads dist/, not the dev server):
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/screenshot.ts / home.png
 *   npx tsx --env-file=.env scripts/screenshot.ts /set/<id>/quiz quiz.png --width 1280
 *
 * Needs EXPO_PUBLIC_SUPABASE_URL / _PUBLISHABLE_KEY, and TEST_USER_A_EMAIL /
 * TEST_USER_A_PASSWORD unless --no-auth is passed. Signs in as the ISOLATION
 * TEST USER, never the owner: the app is OTP-only (D10), so the owner's account
 * has no password a script could use.
 *
 * Set CHROME_PATH to override browser discovery.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const DIST = 'dist';

const CHROME_CANDIDATES = [
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

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * A page under DevTools control.
 *
 * Exported so a probe that needs to DO something — type an answer, press a
 * button, assert what came back — can import this instead of rebuilding the
 * protocol plumbing. `scripts/` already owns the pattern of driving the real
 * app from Node; this is the browser half of it.
 */
export interface Page {
  goto(path: string): Promise<void>;
  /** Evaluate an expression in the page and return its value. */
  evaluate<T = unknown>(expression: string, awaitPromise?: boolean): Promise<T>;
  /** Everything the user can read, as plain text. */
  text(): Promise<string>;
  /** Poll an expression until it returns something truthy. Returns that value. */
  waitFor<T = unknown>(expression: string, what: string, timeoutMs?: number): Promise<T>;
  /** Type into the app's text field. */
  fill(value: string): Promise<void>;
  /** Press the control whose visible label matches exactly, case-insensitively. */
  click(label: string): Promise<void>;
  screenshot(file: string): Promise<void>;
  /** console.* and uncaught exceptions, in order. */
  logs(): string[];
  close(): Promise<void>;
}

function staticServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    let file = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    // The SPA fallback `public/_redirects` gives in production. Without it every
    // route but "/" 404s and the screenshot is of nothing.
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function findChrome(): string {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `No Chrome or Edge found. Looked in:\n  ${CHROME_CANDIDATES.join('\n  ')}\n` +
        'Set CHROME_PATH to point at one.',
    );
  }
  return found;
}

export async function openPage(options: {
  width?: number;
  height?: number;
  /** Sign in as the test user before navigating. Default true. */
  auth?: boolean;
} = {}): Promise<Page> {
  const width = options.width ?? 430;
  const height = options.height ?? 900;
  const auth = options.auth ?? true;

  const server = await staticServer();
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('server has no port');
  const origin = `http://127.0.0.1:${address.port}`;

  const chrome: ChildProcess = spawn(findChrome(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `cdp-${Date.now()}`)}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ]);

  // Chrome prints its DevTools endpoint on stderr once it is listening. Port 0
  // means the OS picks one, so there is nothing to guess.
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
  const logs: string[] = [];

  ws.onmessage = (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args ?? [])
        .map((a: { value?: unknown; description?: string }) => a.value ?? a.description ?? '')
        .join(' ');
      logs.push(`[${msg.params.type}] ${args}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`[exception] ${msg.params.exceptionDetails?.exception?.description ?? '?'}`);
    }
  };

  const send = (method: string, params: unknown = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = (await send('Target.createTarget', { url: 'about:blank' })) as {
    targetId: string;
  };
  const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })) as {
    sessionId: string;
  };
  const on = (method: string, params?: unknown) => send(method, params, sessionId);

  await on('Page.enable');
  await on('Runtime.enable');
  await on('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: width < 700,
  });

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function evaluate<T>(expression: string, awaitPromise = false): Promise<T> {
    const { result } = (await on('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    })) as { result: { value: T } };
    return result.value;
  }

  const text = () => evaluate<string>(`document.querySelector('#root')?.innerText ?? ''`);

  async function waitFor<T>(expression: string, what: string, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await evaluate<T>(expression);
      if (value) return value;
      await pause(250);
    }
    const page = (await text()).replace(/\n/g, ' | ');
    throw new Error(`Timed out waiting for ${what}\n  page showed: ${page}`);
  }

  async function goto(path: string): Promise<void> {
    await on('Page.navigate', { url: origin + path });
    await waitFor(
      `(document.querySelector('#root')?.innerText.trim().length ?? 0) > 0 ? 'y' : ''`,
      'the app to render',
      25_000,
    );
    // Expo Router settles a frame or two after first paint, and TanStack Query
    // needs its first round trip before a screen shows real content.
    await pause(1200);
  }

  /**
   * The app's text field, ignoring the hidden haptic switch.
   *
   * `primeFeedback()` appends an off-screen checkbox on every study screen (see
   * src/ui/feedback.ts), so a bare `input` selector matches while the screen
   * still says "Loading…" — which raced the render and silently typed nowhere.
   */
  const ANSWER_BOX = `[...document.querySelectorAll('input')]
    .find((e) => !['checkbox','radio','hidden','submit','button'].includes(e.type))`;

  async function fill(value: string): Promise<void> {
    await waitFor(`${ANSWER_BOX} ? 'y' : ''`, 'the text field');
    // React tracks an input's value on the DOM node itself, so assigning
    // .value is silently ignored — the native setter plus an input event is
    // what actually reaches onChangeText.
    const ok = await evaluate<string>(`(() => {
      const el = ${ANSWER_BOX};
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
        .set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value === ${JSON.stringify(value)} ? 'ok' : '';
    })()`);
    if (!ok) throw new Error(`Could not type "${value}"`);
  }

  async function click(label: string): Promise<void> {
    await waitFor(
      `[...document.querySelectorAll('div[role="button"], button, [tabindex]')]
        .some((n) => n.innerText.trim().toLowerCase() === ${JSON.stringify(label)}.toLowerCase()) ? 'y' : ''`,
      `a control labelled "${label}"`,
    );
    await evaluate(`(() => {
      const el = [...document.querySelectorAll('div[role="button"], button, [tabindex]')]
        .find((n) => n.innerText.trim().toLowerCase() === ${JSON.stringify(label)}.toLowerCase());
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      el.click();
    })()`);
  }

  async function screenshot(file: string): Promise<void> {
    const { data } = (await on('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    })) as { data: string };
    writeFileSync(file, Buffer.from(data, 'base64'));
  }

  // Land on the origin before writing localStorage — it is per-origin, and
  // about:blank has none.
  await goto('/');

  if (auth) {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    const email = process.env.TEST_USER_A_EMAIL;
    const password = process.env.TEST_USER_A_PASSWORD;
    if (!url || !key || !email || !password) {
      throw new Error(
        'Set EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, ' +
          'TEST_USER_A_EMAIL and TEST_USER_A_PASSWORD — or pass --no-auth.',
      );
    }
    // supabase-js keeps the session in localStorage under this key, so writing
    // it there is indistinguishable from having signed in through the UI. The
    // app is OTP-only, so there is no form a script could fill instead.
    const ref = new URL(url).hostname.split('.')[0];
    const result = await evaluate<string>(
      `(async () => {
        const r = await fetch(${JSON.stringify(url)} + '/auth/v1/token?grant_type=password', {
          method: 'POST',
          headers: { apikey: ${JSON.stringify(key)}, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }),
        });
        const s = await r.json();
        if (!s.access_token) return 'sign-in failed: ' + JSON.stringify(s).slice(0, 200);
        localStorage.setItem('sb-${ref}-auth-token', JSON.stringify(s));
        return 'ok';
      })()`,
      true,
    );
    if (result !== 'ok') throw new Error(result);
  }

  return {
    goto,
    evaluate,
    text,
    waitFor,
    fill,
    click,
    screenshot,
    logs: () => logs,
    close: async () => {
      chrome.kill();
      server.close();
    },
  };
}

// --------------------------------------------------------------------- CLI --

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

  const route = positional[0] ?? '/';
  const out = positional[1] ?? 'screenshot.png';

  if (!existsSync(DIST)) {
    throw new Error(`No ${DIST}/ directory. Run: npx expo export --platform web`);
  }

  const page = await openPage({
    width: Number(flag('--width') ?? 430),
    height: Number(flag('--height') ?? 900),
    auth: !args.includes('--no-auth'),
  });

  try {
    await page.goto(route);
    await page.screenshot(out);

    console.log(`--- ${route} ---`);
    console.log(await page.text());

    const logs = page.logs();
    if (logs.length > 0) {
      console.log('\n--- browser console ---');
      for (const line of logs.slice(-25)) console.log(`  ${line}`);
    }
    console.log(`\nsaved ${out}`);
  } finally {
    await page.close();
  }
}

// Only when run directly, so the helpers above can be imported by other probes.
if (process.argv[1]?.endsWith('screenshot.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
