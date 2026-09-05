/**
 * Phase 7b — the gate for diagram label questions.
 *
 * Spec §6 postpones "diagram/label questions (only when ≥3 labels return
 * confident non-overlapping boxes)". That clause is a GATE, and this script is
 * the thing that opens or closes it. No label-question UI gets built until this
 * reports a pass on real documents.
 *
 * It asks Gemini for each label's bounding box on a figure, then checks the
 * boxes deterministically: are there at least three, is each confident, and do
 * any two overlap? Overlap is the one that matters — a "point at the leaf"
 * question is unanswerable if the leaf box and the stem box cover each other.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/label-box-probe.ts <image> [<image>...]
 */
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { GEMINI_API_BASE, LIGHT_LADDER } from '../src/ai/models';

/** Spec §6's threshold. Fewer than this and label questions are not viable. */
const MIN_CONFIDENT_LABELS = 3;

/**
 * Below this, a box is not trustworthy enough to mark a card wrong over.
 *
 * Deliberately strict: the cost of a bad box is telling a student they were
 * wrong when they were right, which is worse than not asking at all.
 */
const MIN_CONFIDENCE = 0.7;

/**
 * Allowed overlap between two boxes, as a fraction of the smaller one.
 *
 * Not zero: labels on a real diagram sit close together and a leader line can
 * clip a neighbour. A tenth is slack for that without letting two boxes
 * genuinely compete for the same tap.
 */
const MAX_OVERLAP = 0.1;

interface Box {
  label: string;
  /** Normalised 0-1, origin top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
          confidence: { type: 'number' },
        },
        required: ['label', 'x', 'y', 'w', 'h', 'confidence'],
      },
    },
  },
  required: ['labels'],
} as const;

const PROMPT = `This is a labelled diagram. For each labelled PART OF THE SUBJECT, return a
box around the part itself — the thing being pointed at — not around the text of the label and
not around the leader line.

Coordinates are normalised 0 to 1, origin at the top-left: x and y are the box's top-left
corner, w and h its width and height.

Give "confidence" between 0 and 1 for how certain you are that the box encloses the right part.
Be honest and use low values when you are guessing — a wrong box is worse than a missing one.

Only include parts of the subject. Skip titles, captions, footnotes and specimen codes.`;

function mimeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: throw new Error(`unsupported image type: ${ext}`);
  }
}

/**
 * Pixel dimensions of a PNG or JPEG, from the header alone.
 *
 * Needed because the model does not reliably honour "normalised 0 to 1" — see
 * normaliseBoxes. No image library for two header reads.
 */
function imageSize(bytes: Buffer): { width: number; height: number } | null {
  // PNG: IHDR width/height are big-endian at 16 and 20.
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // JPEG: walk the markers to a Start-Of-Frame, which carries the dimensions.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1]!;
      // SOF0-SOF15, excluding the non-frame markers in that range.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return null;
}

/**
 * Convert pixel boxes to normalised ones when the model ignored the instruction.
 *
 * Measured: asked for 0-1 coordinates on two images in the same run, one came
 * back normalised and the other in pixels — `[322, 164, 84, 90]` on a 900x620
 * drawing. Same prompt, same model, different convention.
 *
 * Detected rather than assumed: a normalised box can never exceed 1, so any
 * value above a small tolerance means the whole set is in pixels. Rescaling is
 * deterministic and lossless, so this is a real fix rather than a way of
 * flattering the gate — a box that is still wrong after rescaling still fails.
 */
export function normaliseBoxes(
  boxes: Box[],
  size: { width: number; height: number } | null,
): { boxes: Box[]; rescaled: boolean } {
  const looksLikePixels = boxes.some((b) => b.x > 1.5 || b.y > 1.5 || b.w > 1.5 || b.h > 1.5);
  if (!looksLikePixels || !size) return { boxes, rescaled: false };

  return {
    rescaled: true,
    boxes: boxes.map((b) => ({
      ...b,
      x: b.x / size.width,
      y: b.y / size.height,
      w: b.w / size.width,
      h: b.h / size.height,
    })),
  };
}

/** Intersection area as a fraction of the SMALLER box. */
export function overlapFraction(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const intersection = ix * iy;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller <= 0 ? 0 : intersection / smaller;
}

async function askForBoxes(bytes: Buffer, mime: string): Promise<Box[]> {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: mime, data: bytes.toString('base64') } },
          { text: PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
    },
  };

  // Same ladder the app uses, for the same reason: one model being busy should
  // not decide whether a feature is viable.
  for (const model of LIGHT_LADDER) {
    const res = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY ?? process.env.GK ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 503) continue;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const outer = await res.json();
    const text = (outer.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? '')
      .join('');
    return JSON.parse(text).labels as Box[];
  }
  throw new Error('every model was rate-limited');
}

async function probe(path: string): Promise<boolean> {
  const bytes = readFileSync(path);
  const boxes = await askForBoxes(bytes, mimeFor(extname(path)));

  console.log(`\n${'='.repeat(74)}`);
  console.log(`${basename(path)} — ${boxes.length} label(s) returned`);
  console.log('='.repeat(74));

  const inRange = (b: Box) =>
    b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= 1.001 && b.y + b.h <= 1.001;

  for (const b of boxes) {
    const flags = [
      b.confidence < MIN_CONFIDENCE ? `low confidence ${b.confidence.toFixed(2)}` : null,
      !inRange(b) ? 'off-canvas' : null,
    ].filter(Boolean);
    console.log(
      `  ${b.label.padEnd(22)} conf ${b.confidence.toFixed(2)}  ` +
        `[${b.x.toFixed(2)} ${b.y.toFixed(2)} ${b.w.toFixed(2)} ${b.h.toFixed(2)}]` +
        (flags.length ? `  <- ${flags.join(', ')}` : ''),
    );
  }

  const usable = boxes.filter((b) => b.confidence >= MIN_CONFIDENCE && inRange(b));

  const clashes: string[] = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const o = overlapFraction(usable[i]!, usable[j]!);
      if (o > MAX_OVERLAP) {
        clashes.push(`${usable[i]!.label} / ${usable[j]!.label} overlap ${(o * 100).toFixed(0)}%`);
      }
    }
  }

  const clashing = new Set(clashes.flatMap((c) => c.split(' overlap')[0]!.split(' / ')));
  const clean = usable.filter((b) => !clashing.has(b.label));

  console.log(`\n  confident and on-canvas: ${usable.length}`);
  if (clashes.length) {
    console.log(`  overlapping pairs:`);
    for (const c of clashes) console.log(`    ${c}`);
  }
  console.log(`  confident AND non-overlapping: ${clean.length} (need ${MIN_CONFIDENT_LABELS})`);

  const pass = clean.length >= MIN_CONFIDENT_LABELS;
  console.log(`  => ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

async function main() {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (paths.length === 0) throw new Error('usage: label-box-probe <image> [<image>...]');
  if (!(process.env.GEMINI_API_KEY ?? process.env.GK)) throw new Error('set GEMINI_API_KEY');

  const results: boolean[] = [];
  for (const p of paths) results.push(await probe(p));

  const passed = results.filter(Boolean).length;
  console.log(`\n${'='.repeat(74)}`);
  console.log(`GATE: ${passed}/${results.length} document(s) yielded >= ${MIN_CONFIDENT_LABELS} confident, non-overlapping boxes.`);
  console.log(
    passed === results.length
      ? 'Spec §6 gate PASSES — label questions are viable on this evidence.'
      : 'Spec §6 gate FAILS — do not build label questions on this evidence.',
  );
  console.log('='.repeat(74));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
