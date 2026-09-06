/**
 * Cut the pet sprite sheets into transparent frames.
 *
 * The art is generated as ONE image containing all five stages in a row, on a
 * flat magenta background. That is not a quirk of how it was asked for — it is
 * the whole reason the stages look like the same character: five separate
 * generations drift in colour, outline weight and face, and a pet that changes
 * species when it grows is worse than no pet.
 *
 *   npx tsx scripts/make-pet-assets.ts                    # every sheet found
 *   npx tsx scripts/make-pet-assets.ts assets/cat-stages.jfif cat
 *
 * Writes `assets/<name>-1.webp` … `-5.webp`: magenta keyed out to
 * transparency, each frame trimmed to its ink and capped at MAX_FRAME_PX.
 *
 * No dependency, deliberately: Chrome's canvas does the decoding, keying and
 * re-encoding, and this project already drives Chrome for screenshots and for
 * building test PDFs. An image library would be a large addition for one
 * command that runs about twice in the life of the project.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const STAGES = 5;

/**
 * How magenta a pixel has to be before it counts as background.
 *
 * ## Why this is not a distance to #FF00FF
 *
 * It was, and that test deletes the character's eyes. Pure white is 255 away
 * from magenta in green and identical in red and blue, so a plain
 * red+green+blue distance scores it *closer* to the background than the brown
 * of the body is — and the first version would have punched holes through
 * every eye and, on the cat, through its whole white chest.
 *
 * What actually distinguishes the background is not how far it is from one
 * colour but its SHAPE: magenta is red and blue both high with green markedly
 * lower than both. White has green just as high, so it survives; pink cheeks
 * and a pink nose have red high but blue no higher than green, so they survive
 * too.
 *
 * 45 is loose on purpose. The generated sheet is not one flat colour — the
 * cells sit on slightly different magentas, there are pale pink borders between
 * them, JPEG ringing smears the edges, and the top stage has a warm glow that
 * fades out through pink. A strict test keeps all of that as a fringe.
 */
const CHROMA_FLOOR = 45;
const CHANNEL_FLOOR = 140;

/**
 * Largest a finished frame may be, in pixels on its longest side.
 *
 * The pet is drawn at 132pt at most (`SIZES` in `src/ui/pet.tsx`), so 280
 * covers it at 2× on a retina screen with a little to spare. The generated
 * sheet is far larger than that, and shipping the extra pixels costs bandwidth
 * on a phone to draw detail nobody can see.
 */
const MAX_FRAME_PX = 280;

/**
 * WebP, not PNG — measured, and the margin is not close.
 *
 * These are flat-colour cartoons with hard edges and few distinct tones, which
 * is the case PNG is meant to be good at and WebP is much better at. Measured
 * over all ten frames at the size above:
 *
 *   current PNG, full size   1,150 KB
 *   PNG, resized to 280px      805 KB
 *   WebP, resized to 280px     127 KB
 *
 * The PNG version was **a third of the entire 3.4 MB web build** for a
 * decorative pet. Alpha is preserved either way, and every browser that can run
 * this app supports WebP.
 */
const FRAME_QUALITY = 0.92;

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

const SHEET_EXTENSIONS = ['png', 'jpg', 'jpeg', 'jfif', 'webp'];

/**
 * What kind of image this turned out to be.
 *
 * Read from the first bytes rather than the extension, because the sheets that
 * actually arrived were `.jfif` — what Windows saves a JPEG as from a
 * right-click — and a data URI with the wrong type is a decode error rather
 * than a useful message. Nobody should need to know what a JFIF is to get
 * their potato into the app.
 */
function mimeOf(path: string): string {
  const head = readFileSync(path).subarray(0, 12);
  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error(`${path} is not a PNG, JPEG or WebP.`);
}

/**
 * Every sheet waiting to be cut, and the name its frames take.
 *
 * With no arguments this does the lot: `assets/<name>-stages.<ext>` becomes
 * `assets/<name>-1.webp` … `<name>-5.webp`. Adding a third pet is then dropping
 * one file in and running one command, which is the difference between a
 * feature someone extends and a feature that stays at two.
 */
function findSheets(explicit?: string, explicitName?: string): { path: string; name: string }[] {
  if (explicit) {
    const name = explicitName ?? basename(explicit).replace(/-stages\.[^.]+$/, '');
    if (!existsSync(explicit)) throw new Error(`No such file: ${explicit}`);
    return [{ path: explicit, name }];
  }

  const found = readdirSync('assets')
    .filter((f) => /-stages\.[^.]+$/.test(f) && SHEET_EXTENSIONS.includes(extname(f).slice(1)))
    .map((f) => ({ path: join('assets', f), name: f.replace(/-stages\.[^.]+$/, '') }));

  if (found.length === 0) {
    throw new Error(
      'No sprite sheets in assets/. Save each generated image as\n' +
        `  assets/<name>-stages.{${SHEET_EXTENSIONS.join(',')}}\n` +
        'one image, five stages in a row.',
    );
  }
  return found;
}

async function main() {
  const sheets = findSheets(process.argv[2], process.argv[3]);

  const chrome: ChildProcess = spawn(
    CHROME_CANDIDATES.find((p) => existsSync(p)) ?? 'chrome',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `cdp-pet-${Date.now()}`)}`,
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

  for (const sheet of sheets) {
    const mime = mimeOf(sheet.path);
    const dataUri = `data:${mime};base64,${readFileSync(sheet.path).toString('base64')}`;
    console.log(`\n${sheet.path} (${mime}) -> ${sheet.name}-1..${STAGES}.webp`);

    const { result } = (await raw(
      'Runtime.evaluate',
      {
        expression: `(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(dataUri)};
        await img.decode();

        const out = [];

        for (let s = 0; s < ${STAGES}; s++) {
          // Exact boundaries, rounded per cell rather than one floored width:
          // 2064 across five cells is 412.8 each, and flooring drifts four
          // pixels by the last frame — enough to slice a tail off.
          const x0 = Math.round((s * img.width) / ${STAGES});
          const x1 = Math.round(((s + 1) * img.width) / ${STAGES});

          const c = document.createElement('canvas');
          c.width = x1 - x0; c.height = img.height;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, -x0, 0);

          const data = g.getImageData(0, 0, c.width, c.height);
          const d = data.data;

          const w = c.width, h = c.height;
          const chromaOf = (i) => Math.min(d[i] - d[i + 1], d[i + 2] - d[i + 1]);

          // Pass 1 — the flat background. Magenta is red and blue high with
          // green markedly lower than BOTH. White has green just as high, so
          // eyes and a white chest survive.
          for (let i = 0; i < d.length; i += 4) {
            if (chromaOf(i) > ${CHROMA_FLOOR} && d[i] > ${CHANNEL_FLOOR} && d[i + 2] > ${CHANNEL_FLOOR}) {
              d[i + 3] = 0;
            }
          }

          // Pass 2 — everything else that is not the character.
          //
          // The top stage is drawn with a warm glow behind it, and a glow does
          // not end: it fades magenta -> pink -> coral -> gold across a handful
          // of pixels. Measured along one row: 253,124,155 then 255,135,144
          // then 254,148,134 then gold. No colour threshold cuts that cleanly,
          // and pass 1 left a hard pink disc that read as a blob rather than a
          // glow.
          //
          // So this stops asking what colour a pixel is and asks where it is:
          // flood inwards from the frame edge, through anything that is not the
          // character's dark outline. The outline is closed, so the flood
          // washes round the character and stops — taking the glow, the pale
          // panel borders, the drop shadow and the loose sparkles with it, and
          // leaving everything the outline encloses untouched.
          //
          // MUST run before the trim: trimming makes the character touch all
          // four edges by definition, so a flood seeded from the border would
          // start inside it and eat the pet.
          const OUTLINE_MAX_LUMA = 90;
          const stack = [];
          for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
          for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }

          while (stack.length > 0) {
            const px = stack.pop();
            const i = px * 4;
            if (d[i + 3] === 0 && d[i] === 0) continue;   // already visited
            const luma = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
            // The dark outline blocks; the magenta shadow under the character
            // is dark too, so its chroma lets it through.
            if (d[i + 3] !== 0 && luma <= OUTLINE_MAX_LUMA && chromaOf(i) <= ${CHROMA_FLOOR}) continue;

            // Zeroed rather than only made transparent, so the visited test
            // above is exact and the flood cannot loop.
            d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0;

            const x = px % w, y = (px - x) / w;
            if (x > 0) stack.push(px - 1);
            if (x < w - 1) stack.push(px + 1);
            if (y > 0) stack.push(px - w);
            if (y < h - 1) stack.push(px + w);
          }

          g.putImageData(data, 0, 0);

          // Trim to what is actually drawn. The cells are generated with
          // generous padding and the stages are different sizes inside them,
          // so untrimmed frames would make the pet appear to shift and
          // shrink as it grows — the opposite of the intended effect.
          let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
          for (let y = 0; y < c.height; y++) {
            for (let x = 0; x < c.width; x++) {
              if (d[(y * c.width + x) * 4 + 3] > 8) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          if (maxX < 0) { out.push({ error: 'stage ' + (s + 1) + ' is empty after keying' }); continue; }

          const tw = maxX - minX + 1, th = maxY - minY + 1;
          // Trim and downscale in ONE draw: resampling an already-resampled
          // frame softens the outline twice over.
          const scale = Math.min(1, ${MAX_FRAME_PX} / Math.max(tw, th));
          const trimmed = document.createElement('canvas');
          trimmed.width = Math.round(tw * scale);
          trimmed.height = Math.round(th * scale);
          const tg = trimmed.getContext('2d');
          tg.imageSmoothingQuality = 'high';
          tg.drawImage(c, minX, minY, tw, th, 0, 0, trimmed.width, trimmed.height);

          out.push({
            png: trimmed.toDataURL('image/webp', ${FRAME_QUALITY}),
            w: trimmed.width,
            h: trimmed.height,
          });
        }
        return out;
      })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    )) as { result: { value: { png?: string; w?: number; h?: number; error?: string }[] } };

    for (const [i, stage] of result.value.entries()) {
      if (stage.error) throw new Error(`${sheet.path}: ${stage.error}`);
      const file = join('assets', `${sheet.name}-${i + 1}.webp`);
      writeFileSync(file, Buffer.from(stage.png!.split(',')[1]!, 'base64'));
      console.log(`  ${file}  ${stage.w}x${stage.h}`);
    }
  }

  chrome.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
