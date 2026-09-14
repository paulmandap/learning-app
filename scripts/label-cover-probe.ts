/**
 * Can Gemini say where a diagram's labels are, well enough to COVER the one a
 * card's answer is? (NOTES §44.2.)
 *
 *   npx tsx --env-file=.env scripts/label-cover-probe.ts [--runs=3] [--only=alu-block,cell-leaders] [--model=<id>] [--out=<dir>]
 *
 * The owner, 2026-09-14: a card's picture gave its answer away — "it's not
 * censored". Covering is not NOTES §8.2's gate (`label-box-probe.ts`). That asked
 * for boxes around the PART a label points at, for tap-the-part questions, in an
 * invented 0-1 format. Covering needs a box around the label's TEXT, asked for in
 * Gemini's own `box_2d` format (0-1000), and a cover a little too big is harmless.
 *
 * The diagrams are drawn here, in headless Chrome, so where every label really
 * is is known to the pixel. A label counts as hidden only when its cover — the
 * returned box padded by a quarter of its height — contains every pixel of its
 * text. Pictures of the covers against the truth are written to --out.
 *
 * Spends real Gemini quota: one request per diagram per run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPage } from './screenshot';
import { GEMINI_API_BASE, LIGHT_LADDER } from '../src/ai/models';

const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const RUNS = Number(flag('runs') ?? 3);
const ONLY = flag('only')?.split(',');
const FORCE = flag('model');
const LADDER = FORCE ? [FORCE] : LIGHT_LADDER;
const OUT = flag('out') ?? join(process.env.TEMP ?? '/tmp', 'label-cover');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Rect = { x0: number; y0: number; x1: number; y1: number };
type Truth = { text: string; box: Rect };
type Picture = { name: string; mime: string; data: string; width: number; height: number; truth: Truth[] };
type Returned = { text: string; box_2d: number[] };

const RENDER = String.raw`(() => {
  const out = [];
  const textBox = (g, text, x, y) => {
    const m = g.measureText(text);
    return { x0: x - (m.actualBoundingBoxLeft || 0), y0: y - m.actualBoundingBoxAscent, x1: x + m.actualBoundingBoxRight, y1: y + m.actualBoundingBoxDescent };
  };
  const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

  // 1. A block diagram like the owner's ALU figure.
  const W = 1000, H = 440;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#e8a05a'; g.lineWidth = 4;
  g.font = '22px "Times New Roman", serif'; g.fillStyle = '#222';
  const label = (text, cx, cy) => { const w = g.measureText(text).width; const x = cx - w / 2; g.fillText(text, x, cy); return textBox(g, text, x, cy); };
  const truth = [];
  g.strokeRect(270, 40, 240, 80); truth.push({ text: 'Status Register', box: label('Status Register', 390, 88) });
  g.strokeRect(260, 200, 260, 150); truth.push({ text: 'Binary Adder', box: label('Binary Adder', 390, 282) });
  g.strokeRect(20, 250, 160, 60); truth.push({ text: 'Shifter', box: label('Shifter', 100, 288) });
  g.strokeRect(570, 215, 230, 50); truth.push({ text: 'Temporary', box: label('Temporary', 685, 248) });
  g.strokeRect(570, 290, 230, 50); truth.push({ text: 'Accumulator', box: label('Accumulator', 685, 323) });
  g.strokeRect(880, 20, 100, 390);
  truth.push({ text: 'Internal CPU Bus', box: [label('Internal', 930, 170), label('CPU', 930, 200), label('Bus', 930, 230)].reduce(union) });
  g.lineWidth = 3;
  const line = (x0, y0, x1, y1) => { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  line(510, 75, 875, 75); line(510, 85, 875, 85);
  line(385, 125, 385, 195); line(395, 125, 395, 195);
  line(805, 235, 875, 235); line(805, 245, 875, 245);
  line(805, 310, 875, 310); line(805, 320, 875, 320);
  line(525, 240, 565, 240); line(525, 315, 565, 315);
  line(185, 280, 255, 280);
  line(100, 315, 100, 390); line(100, 390, 875, 390); line(100, 400, 875, 400);
  out.push({ name: 'alu-block', mime: 'image/png', data: c.toDataURL('image/png'), width: W, height: H, truth });

  // 2. The same, as a phone photo of a page: smaller, turned, soft, compressed.
  const s = 0.8, th = 2.5 * Math.PI / 180, W2 = Math.round(W * s), H2 = Math.round(H * s);
  const p = document.createElement('canvas'); p.width = W2; p.height = H2;
  const q = p.getContext('2d');
  q.fillStyle = '#e9e2d6'; q.fillRect(0, 0, W2, H2);
  q.save(); q.filter = 'blur(0.9px)'; q.translate(W2 / 2, H2 / 2); q.rotate(th); q.scale(s, s); q.drawImage(c, -W / 2, -H / 2); q.restore();
  q.fillStyle = 'rgba(255,225,190,0.14)'; q.fillRect(0, 0, W2, H2);
  const map = (x, y) => { const dx = (x - W / 2) * s, dy = (y - H / 2) * s; return { x: W2 / 2 + dx * Math.cos(th) - dy * Math.sin(th), y: H2 / 2 + dx * Math.sin(th) + dy * Math.cos(th) }; };
  const moved = truth.map((t) => {
    const pts = [map(t.box.x0, t.box.y0), map(t.box.x1, t.box.y0), map(t.box.x0, t.box.y1), map(t.box.x1, t.box.y1)];
    return { text: t.text, box: { x0: Math.min(...pts.map((v) => v.x)), y0: Math.min(...pts.map((v) => v.y)), x1: Math.max(...pts.map((v) => v.x)), y1: Math.max(...pts.map((v) => v.y)) } };
  });
  out.push({ name: 'alu-photo', mime: 'image/jpeg', data: p.toDataURL('image/jpeg', 0.6), width: W2, height: H2, truth: moved });

  // 3. A plant cell: labels outside with leader lines, some a line apart.
  const C = document.createElement('canvas'); C.width = 900; C.height = 640;
  const k = C.getContext('2d');
  k.fillStyle = '#fff'; k.fillRect(0, 0, 900, 640);
  k.strokeStyle = '#2d6a4f'; k.lineWidth = 10; k.strokeRect(260, 120, 380, 400);
  k.strokeStyle = '#74c69d'; k.lineWidth = 4; k.strokeRect(275, 135, 350, 370);
  k.fillStyle = '#cdb4db'; k.beginPath(); k.arc(520, 230, 55, 0, 7); k.fill();
  k.fillStyle = '#a8dadc'; k.beginPath(); k.ellipse(420, 390, 110, 80, 0, 0, 7); k.fill();
  k.fillStyle = '#52b788'; [[320, 190], [340, 470], [590, 440]].forEach(([x, y]) => { k.beginPath(); k.ellipse(x, y, 28, 14, 0.4, 0, 7); k.fill(); });
  k.fillStyle = '#e76f51'; k.beginPath(); k.ellipse(560, 340, 26, 12, -0.3, 0, 7); k.fill();
  k.font = '20px Arial, sans-serif'; k.fillStyle = '#111'; k.strokeStyle = '#111'; k.lineWidth = 1.5;
  const lab = (text, x, y, tx, ty) => {
    k.fillText(text, x, y); const b = textBox(k, text, x, y);
    k.beginPath(); k.moveTo(x < 450 ? b.x1 + 6 : b.x0 - 6, (b.y0 + b.y1) / 2); k.lineTo(tx, ty); k.stroke();
    return { text, box: b };
  };
  const cell = [
    lab('Cell wall', 60, 130, 262, 150),
    lab('Cell membrane', 60, 160, 277, 170),
    lab('Chloroplast', 60, 195, 305, 190),
    lab('Vacuole', 60, 400, 330, 390),
    lab('Nucleus', 720, 220, 575, 230),
    lab('Mitochondrion', 700, 345, 586, 340),
    lab('Cytoplasm', 720, 480, 610, 480),
  ];
  k.font = 'bold 26px Arial'; k.fillText('Plant cell', 390, 60);
  out.push({ name: 'cell-leaders', mime: 'image/png', data: C.toDataURL('image/png'), width: 900, height: 640, truth: cell });
  return out;
})()`;

const PROMPT = `Find the text labels in this picture.

For each label give its text exactly as written, and "box_2d": [ymin, xmin, ymax, xmax] around the TEXT of the label itself — not the shape or part it names — with coordinates normalised to 0-1000 relative to the whole image.

A label written over several lines is ONE label with one box. Include every label, however small.`;

const SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, box_2d: { type: 'array', items: { type: 'integer' } } },
        required: ['text', 'box_2d'],
      },
    },
  },
  required: ['labels'],
};

async function ask(pic: Picture): Promise<{ model: string; labels: Returned[]; ms: number }> {
  const body = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: pic.mime, data: pic.data.split(',')[1] } }, { text: PROMPT }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0 },
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const model of LADDER) {
      const t0 = Date.now();
      let res: Response;
      try {
        res = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        console.log(`   (connection dropped on ${model}: ${err instanceof Error ? err.message : String(err)} — trying again)`);
        continue;
      }
      if (res.status === 429 || res.status === 503) continue;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const outer = await res.json();
      const text = (outer.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
      return { model, labels: JSON.parse(text).labels as Returned[], ms: Date.now() - t0 };
    }
    await sleep(10_000);
  }
  throw new Error('every model was busy');
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s: string) => norm(s).split(' ').filter(Boolean);
const toPx = (b: number[], pic: Picture): Rect => ({
  y0: (b[0]! / 1000) * pic.height,
  x0: (b[1]! / 1000) * pic.width,
  y1: (b[2]! / 1000) * pic.height,
  x1: (b[3]! / 1000) * pic.width,
});
const union = (a: Rect, b: Rect): Rect => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const inter = (a: Rect, b: Rect) =>
  area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
/** The cover drawn over a returned box: a little bigger, so an edge is never left showing. */
const pad = (r: Rect): Rect => {
  const p = Math.min(14, Math.max(6, (r.y1 - r.y0) * 0.25));
  return { x0: r.x0 - p, y0: r.y0 - p, x1: r.x1 + p, y1: r.y1 + p };
};
/** How far the true text sticks out of the cover, in pixels (0 = fully hidden). */
const stickOut = (truth: Rect, cover: Rect) =>
  Math.max(0, cover.x0 - truth.x0, cover.y0 - truth.y0, truth.x1 - cover.x1, truth.y1 - cover.y1);

/** The owner's two cards from the ALU figure (NOTES §44.2). */
const CARDS = [
  {
    q: 'When designing an internal processor pathway to connect registers like the Shifter and Status Register, what component should be utilized?',
    a: 'An Internal CPU Bus should be used to connect the related registers.',
  },
  {
    q: 'Which register related to the internal CPU bus is explicitly listed alongside the Status Register and Temporary register?',
    a: 'Accumulator',
  },
];
const hasPhrase = (hay: string, needle: string) => ` ${norm(hay)} `.includes(` ${norm(needle)} `);

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  mkdirSync(OUT, { recursive: true });
  const page = await openPage({ width: 600, height: 600, auth: false });
  const pictures = await page.evaluate<Picture[]>(RENDER);
  for (const pic of pictures) {
    writeFileSync(join(OUT, `${pic.name}.${pic.mime === 'image/png' ? 'png' : 'jpg'}`), Buffer.from(pic.data.split(',')[1]!, 'base64'));
  }

  const totals = { labels: 0, found: 0, hidden: 0, spills: 0 };
  for (const pic of pictures.filter((p) => !ONLY || ONLY.includes(p.name))) {
    console.log(`\n${'='.repeat(78)}\n${pic.name} (${pic.width}x${pic.height}) — ${pic.truth.length} labels\n${'='.repeat(78)}`);
    for (let run = 1; run <= RUNS; run++) {
      const { model, labels, ms } = await ask(pic);
      const scale = labels.flatMap((l) => l.box_2d).every((v) => v <= 1) ? ' (looks 0-1, not 0-1000!)' : '';
      console.log(`run ${run}: ${model}, ${(ms / 1000).toFixed(1)}s, ${labels.length} returned${scale}`);
      const covers: { truth: Truth; cover: Rect | null }[] = [];
      for (const t of pic.truth) {
        const tw = words(t.text);
        const parts = labels.filter((l) => {
          const lw = words(l.text);
          return lw.length > 0 && lw.every((w) => tw.includes(w));
        });
        const got = new Set(parts.flatMap((l) => words(l.text)));
        totals.labels++;
        if (!tw.every((w) => got.has(w))) {
          console.log(`   MISSING   ${t.text}`);
          covers.push({ truth: t, cover: null });
          continue;
        }
        totals.found++;
        const box = parts.map((l) => toPx(l.box_2d, pic)).reduce(union);
        const cover = pad(box);
        const out = stickOut(t.box, cover);
        const iou = inter(box, t.box) / (area(box) + area(t.box) - inter(box, t.box));
        const hit = pic.truth.filter((o) => o !== t && inter(cover, o.box) / area(o.box) > 0.25).map((o) => o.text);
        if (out === 0) totals.hidden++;
        if (hit.length) totals.spills++;
        covers.push({ truth: t, cover });
        console.log(
          `   ${out === 0 ? 'hidden ' : 'SHOWING'}   ${t.text.padEnd(18)} overlap ${(iou * 100).toFixed(0).padStart(3)}%` +
            (out > 0 ? `  sticks out ${out.toFixed(0)}px` : '') +
            (hit.length ? `  ALSO COVERS ${hit.join(', ')}` : '') +
            (parts.length > 1 ? `  (${parts.length} pieces)` : ''),
        );
      }
      if (run === 1) {
        const overlay = await page.evaluate<string>(
          `(async () => {
            const img = new Image(); img.src = ${JSON.stringify(pic.data)}; await img.decode();
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
            const g = c.getContext('2d'); g.drawImage(img, 0, 0);
            for (const { truth, cover } of ${JSON.stringify(covers)}) {
              g.strokeStyle = '#00aa44'; g.lineWidth = 2; g.strokeRect(truth.box.x0, truth.box.y0, truth.box.x1 - truth.box.x0, truth.box.y1 - truth.box.y0);
              if (cover) { g.fillStyle = 'rgba(220,0,0,0.35)'; g.fillRect(cover.x0, cover.y0, cover.x1 - cover.x0, cover.y1 - cover.y0); }
            }
            return c.toDataURL('image/png');
          })()`,
          true,
        );
        writeFileSync(join(OUT, `${pic.name}-covers${FORCE ? `-${FORCE}` : ''}.png`), Buffer.from(overlay.split(',')[1]!, 'base64'));

        if (pic.name.startsWith('alu')) {
          for (const card of CARDS) {
            const plan = labels.filter((l) => hasPhrase(card.a, l.text) && !hasPhrase(card.q, l.text)).map((l) => norm(l.text));
            console.log(`   card "${card.a.slice(0, 40)}" would cover: ${plan.length ? plan.join(', ') : 'NOTHING'}`);
          }
        }
      }
    }
  }
  await page.close();
  console.log(`\n${'='.repeat(78)}`);
  console.log(
    `ALL RUNS: ${totals.found}/${totals.labels} labels found, ${totals.hidden}/${totals.labels} fully hidden by their cover, ` +
      `${totals.spills} covers also hide a neighbour`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
