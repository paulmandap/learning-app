/**
 * What actually stops a big upload? (Phase 10 question 2)
 *
 * `MAX_FILE_BYTES` is 15 MB because `MAX_INLINE_BYTES` is, and that number was
 * chosen conservatively rather than measured: Google allows 50 MB per PDF and
 * 100 MB per inline request (NOTES §2.3). So a 20 MB scanned PDF is refused
 * today by a limit we invented.
 *
 * Raising it is a one-line change and therefore the cheapest option — which is
 * exactly why it needs measuring first. Bytes are not the only ceiling a read
 * has to clear:
 *
 *   - output tokens — the read transcribes EVERY page in ONE call, and a
 *     truncated response fails `parseReadResult` and reaches the student as
 *     "We couldn't read that file";
 *   - CALL_TIMEOUT_MS (100 s) — an abort is treated as retryable, so a read
 *     that is merely slow costs the full ladder before it gives up;
 *   - base64 — an inline request carries the file expanded by 4/3, so the
 *     100 MB request ceiling arrives at 75 MB of file.
 *
 * All three scale with PAGES, not with bytes, and a scan is heavy per page
 * while a text PDF is not. That is the hypothesis this script exists to test.
 *
 *   npx tsx --env-file=.env scripts/large-file-probe.ts make big.pdf --pages 12
 *   npx tsx --env-file=.env scripts/large-file-probe.ts read big.pdf
 *
 * `make` needs Chrome (as scripts/screenshot.ts does); `read` needs
 * GEMINI_API_KEY. Test documents are written where you point them and are NOT
 * committed — same rule as verify-phase2.ts, so nobody's notes end up in git.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { GEMINI_API_BASE, LIGHT_LADDER } from '../src/ai/models';
import { READ_SYSTEM_PROMPT } from '../src/ai/prompts';
import { READ_RESPONSE_SCHEMA } from '../src/ai/schemas';

const MB = 1024 * 1024;

/** The provider's own deadline. A read slower than this is a failed read. */
const CALL_TIMEOUT_MS = 100_000;

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

// ------------------------------------------------------------------ make --

/**
 * The page content, and the ground truth for the read.
 *
 * Every page carries a canary — an invented specimen code and a number that is
 * wrong in the real world — so "it read the page" can be told apart from "it
 * recited plant biology", the same discriminator NOTES §5.2 uses. Without one,
 * a fluent transcription of a page it could not actually see looks like a pass.
 */
const TOPICS = [
  'Cell structure', 'Photosynthesis', 'Respiration', 'Transport in plants',
  'Transpiration', 'Mineral uptake', 'Growth responses', 'Reproduction',
  'Seed dispersal', 'Germination', 'Plant hormones', 'Leaf anatomy',
  'Root systems', 'Stem tissues', 'Flower structure', 'Pollination',
  'Fruit development', 'Dormancy', 'Photoperiodism', 'Stress responses',
  'Nutrient cycling', 'Symbiosis', 'Plant defences', 'Classification',
];

function pageLines(n: number): string[] {
  const topic = TOPICS[(n - 1) % TOPICS.length]!;
  return [
    `Page ${n} — ${topic}`,
    '',
    `Specimen LF-${100 + n} was examined under standard laboratory conditions`,
    `and its measurements recorded by the demonstrator on the same afternoon.`,
    ``,
    `1. The stomatal density of specimen LF-${100 + n} was ${300 + n} per square`,
    `   millimetre, measured on the lower surface of the blade.`,
    `2. Water moved through the xylem at roughly ${10 + n} centimetres per hour`,
    `   under the conditions described in the method above.`,
    `3. Vance's rule states that a leaf loses turgor once its water potential`,
    `   falls below the critical value for the species.`,
    `4. The cortex lies between the epidermis and the vascular cylinder, and`,
    `   stores starch in the mature root.`,
    `5. Guard cells open the pore when they take up potassium ions and the`,
    `   resulting turgor bends them apart.`,
    ``,
    `The demonstrator noted that ${topic.toLowerCase()} is examined in the`,
    `written paper and should be revised alongside the diagram on the sheet.`,
  ];
}

function findChrome(): string {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error(`No Chrome or Edge found. Set CHROME_PATH.`);
  return found;
}

/**
 * A minimal DevTools session.
 *
 * NOT `openPage` from screenshot.ts: that serves dist/ and signs a user in,
 * which this needs none of, and it does not expose Page.printToPDF. Sharing it
 * would mean widening the harness that catches UI defects for the sake of a
 * one-off document generator.
 */
async function withChrome<T>(fn: (
  send: (method: string, params?: unknown) => Promise<Record<string, unknown>>,
) => Promise<T>): Promise<T> {
  const chrome: ChildProcess = spawn(findChrome(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `cdp-pdf-${Date.now()}`)}`,
    'about:blank',
  ]);

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
  const send = (method: string, params?: unknown) => raw(method, params, sessionId);

  await send('Page.enable');
  await send('Runtime.enable');

  try {
    return await fn(send);
  } finally {
    chrome.kill();
  }
}

/**
 * Build a PDF that behaves like a phone scan: every page is one photographic
 * image with no text layer at all.
 *
 * The grain is the point. A clean render of text compresses to almost nothing,
 * so a "20 MB PDF" built that way would have hundreds of pages and would test
 * something else entirely. Film grain is also what a real scan or photo has,
 * and it is what makes those files big.
 */
async function makePdf(out: string, pages: number, grain: number, quality: number) {
  const bytes = await withChrome(async (send) => {
    const built = await send('Runtime.evaluate', {
      expression: `(async () => {
        const PAGES = ${pages}, GRAIN = ${grain}, Q = ${quality};
        const lines = ${JSON.stringify(Array.from({ length: pages }, (_, i) => pageLines(i + 1)))};
        document.head.innerHTML =
          '<style>@page{size:A4;margin:0}html,body{margin:0;padding:0}' +
          'img{display:block;width:100vw;height:100vh;break-after:page}</style>';
        document.body.innerHTML = '';
        for (let p = 0; p < PAGES; p++) {
          const c = document.createElement('canvas');
          c.width = 1654; c.height = 2339;               // A4 at 200 dpi
          const g = c.getContext('2d');
          g.fillStyle = '#fbfaf7'; g.fillRect(0, 0, c.width, c.height);
          g.fillStyle = '#14110d';
          lines[p].forEach((t, i) => {
            g.font = i === 0 ? 'bold 58px Georgia, serif' : '40px Georgia, serif';
            g.fillText(t, 130, 220 + i * 78);
          });
          // Grain, applied after the text so the text stays legible under it.
          const img = g.getImageData(0, 0, c.width, c.height);
          const d = img.data;
          for (let i = 0; i < d.length; i += 4) {
            const v = (Math.random() - 0.5) * GRAIN;
            d[i] += v; d[i + 1] += v; d[i + 2] += v;
          }
          g.putImageData(img, 0, 0);
          const el = document.createElement('img');
          el.src = c.toDataURL('image/jpeg', Q);
          await new Promise((r) => { el.onload = r; document.body.appendChild(el); });
        }
        return document.querySelectorAll('img').length;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const made = (built as { result: { value: number } }).result.value;
    if (made !== pages) throw new Error(`built ${made} pages, wanted ${pages}`);

    const { data } = (await send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    })) as unknown as { data: string };
    return Buffer.from(data, 'base64');
  });

  writeFileSync(out, bytes);
  console.log(
    `${out}: ${pages} pages, ${(bytes.length / MB).toFixed(1)} MB ` +
      `(${(bytes.length / pages / MB).toFixed(2)} MB/page), ` +
      `base64 ${(Math.ceil(bytes.length / 3) * 4 / MB).toFixed(1)} MB`,
  );
}

// ------------------------------------------------------------------ read --

interface Attempt {
  model: string;
  status: number;
  ms: number;
  promptTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  finishReason?: string;
  error?: string;
  pages?: number;
  canaries?: number;
  readability?: string;
}

/**
 * The read request, byte for byte as `readDocument` sends it.
 *
 * Called directly rather than through GeminiBrowserProvider for one reason:
 * the provider returns only the parsed payload, and the numbers that decide
 * this question — finishReason, output tokens, thinking tokens — are in the
 * envelope it discards. The prompt and schema are imported, not copied, so a
 * change to either shows up here.
 */
async function readOnce(model: string, file: Buffer, key: string): Promise<Attempt> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: READ_SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'application/pdf', data: file.toString('base64') } },
          { text: 'Transcribe every page of this document using the schema.' },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: READ_RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  const started = Date.now();
  const controller = new AbortController();
  // Deliberately longer than the app's own deadline, so a read that WOULD have
  // been aborted still reports how long it actually needed. A number is worth
  // more here than a reproduction of the failure.
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    const response = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    const json = (await response.json()) as any;

    if (!response.ok) {
      return { model, status: response.status, ms, error: json?.error?.status ?? 'error' };
    }

    const usage = json.usageMetadata ?? {};
    const candidate = json.candidates?.[0];
    const text = candidate?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';

    let pages: number | undefined;
    let canaries: number | undefined;
    let readability: string | undefined;
    try {
      const parsed = JSON.parse(text);
      const list = parsed.pages ?? [];
      pages = list.length;
      const all = JSON.stringify(list);
      // One canary per page, each unique to it — so this counts pages actually
      // read, not pages the model guessed the shape of.
      canaries = list.filter((_: unknown, i: number) => all.includes(`LF-${101 + i}`)).length;
      const scores = list.map((p: any) => p.readability);
      readability = scores.length
        ? `${Math.min(...scores).toFixed(2)}-${Math.max(...scores).toFixed(2)}`
        : 'none';
    } catch {
      // A truncated response is still valid JSON-shaped text up to the cut, so
      // this failing IS the finding, not a bug in the probe.
      pages = undefined;
    }

    return {
      model,
      status: response.status,
      ms,
      promptTokens: usage.promptTokenCount,
      outputTokens: usage.candidatesTokenCount,
      thoughtTokens: usage.thoughtsTokenCount,
      finishReason: candidate?.finishReason,
      pages,
      canaries,
      readability,
    };
  } catch (err) {
    return {
      model,
      status: 0,
      ms: Date.now() - started,
      error: err instanceof Error ? err.name : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is the free tier healthy enough for a timing number to mean anything?
 *
 * HANDOFF's rule, and it has already saved one wrong conclusion: latency on a
 * shedding tier is Google-side queueing and says nothing about payload size.
 */
async function healthGate(key: string): Promise<boolean> {
  for (const model of LIGHT_LADDER) {
    const started = Date.now();
    const r = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
      }),
    });
    const ms = Date.now() - started;
    console.log(`  gate ${model.padEnd(22)} ${r.status} in ${(ms / 1000).toFixed(1)}s`);
    if (r.ok) return ms < 5000;
  }
  return false;
}

async function readProbe(file: string) {
  const key = process.env.GEMINI_API_KEY ?? process.env.GK;
  if (!key) throw new Error('Set GEMINI_API_KEY (or GK).');
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);

  const bytes = readFileSync(file);
  const size = statSync(file).size;
  console.log(
    `\n${file}: ${(size / MB).toFixed(1)} MB on disk, ` +
      `${(Math.ceil(size / 3) * 4 / MB).toFixed(1)} MB once base64-encoded ` +
      `(the request ceiling is 100 MB, the PDF ceiling 50 MB)\n`,
  );

  console.log('Tier health — a timing number is noise unless this answers in <5s:');
  const healthy = await healthGate(key);
  console.log(`  => ${healthy ? 'HEALTHY' : 'DEGRADED — treat every duration below as an upper bound'}\n`);

  for (const model of LIGHT_LADDER) {
    const a = await readOnce(model, bytes, key);
    const secs = (a.ms / 1000).toFixed(1);
    if (a.error) {
      console.log(`${a.model.padEnd(22)} ${a.status || 'threw'} ${a.error} in ${secs}s`);
      // Same rule as the provider: walk the ladder on a transient failure only.
      if (a.status === 429 || a.status === 503 || a.status === 0) continue;
      break;
    }
    console.log(
      `${a.model.padEnd(22)} 200 in ${secs}s  ` +
        `finish=${a.finishReason}  in=${a.promptTokens} out=${a.outputTokens} ` +
        `think=${a.thoughtTokens ?? 0}\n` +
        `  pages=${a.pages ?? 'UNPARSEABLE'} canaries=${a.canaries ?? '-'} ` +
        `readability=${a.readability ?? '-'}\n` +
        `  vs the app's ${CALL_TIMEOUT_MS / 1000}s deadline: ` +
        `${a.ms > CALL_TIMEOUT_MS ? 'WOULD HAVE BEEN ABORTED' : 'within it'}\n` +
        `  vs the 65,536 output-token ceiling: ` +
        `${(((a.outputTokens ?? 0) / 65536) * 100).toFixed(1)}% used`,
    );
    break;
  }
}

// ------------------------------------------------------------------- CLI --

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: number) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : Number(args[i + 1]);
  };
  const command = args[0];
  const file = args[1];
  if (!file || (command !== 'make' && command !== 'read')) {
    throw new Error(
      'Usage:\n' +
        '  large-file-probe.ts make <out.pdf> [--pages 12] [--grain 90] [--quality 0.92]\n' +
        '  large-file-probe.ts read <in.pdf>',
    );
  }

  if (command === 'make') {
    await makePdf(file, flag('--pages', 12), flag('--grain', 90), flag('--quality', 0.92));
  } else {
    await readProbe(file);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
