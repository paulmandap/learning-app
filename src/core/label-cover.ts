/**
 * Covering the answer on a card's picture (NOTES §44).
 *
 * Pure. Cards made from a picture are written from its own words, so its labels
 * ARE the answers: shown with the question, uncovered, the owner's first diagram
 * gave every one away — *"it's not censored"*. Gemini says where each label is
 * (`locateLabels`, stored on the document by migration 0019), and this decides
 * which labels a card covers and which side of the card the picture goes on.
 *
 * The one rule that is not negotiable: **when in doubt, the picture goes with
 * the answer.** No positions, positions from a model not measured to place them
 * well, or a reply in the wrong units — all of those show the picture after the
 * flip, where it cannot give anything away.
 */

/** A label on a picture: its text, and [ymin, xmin, ymax, xmax] in thousandths of the picture. */
export interface LabelBox {
  text: string;
  box: [number, number, number, number];
}

/** What `documents.labels` holds (migration 0019). */
export interface StoredLabels {
  /** The model that placed them. Only the one measured to place them well is trusted — `LABEL_MODEL`. */
  model: string;
  labels: LabelBox[];
}

export interface PicturePlacement {
  side: 'question' | 'answer';
  /** The labels to cover when the picture is with the question. */
  covers: LabelBox[];
}

/**
 * Past this share of a picture's labels covered, it goes with the answer
 * instead: a diagram that is mostly blanks helps nobody answer anything.
 */
export const MAX_COVERED_SHARE = 0.6;

type Box = [number, number, number, number];

const isBox = (b: unknown): b is Box =>
  Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && Number.isFinite(v));

/**
 * The labels in a `locateLabels` reply, or null when the reply cannot be trusted.
 *
 * The prompt asks for `box_2d` in thousandths; this checks it. A reply with every
 * coordinate at 1 or under came back in fractions, and one with a coordinate
 * past 1000 came back in pixels — the same prompt did both in NOTES §8.2. Both
 * are refused rather than rescaled: a picture whose positions are in doubt goes
 * with the answer. A malformed entry costs only itself.
 */
export function parseLabelBoxes(payload: unknown): LabelBox[] | null {
  const container =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload) && 'labels' in payload
      ? (payload as { labels: unknown }).labels
      : payload;
  if (!Array.isArray(container)) return null;

  const raw = container.flatMap((entry): LabelBox[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { text, box_2d } = entry as { text?: unknown; box_2d?: unknown };
    if (typeof text !== 'string' || text.trim().length === 0 || !isBox(box_2d)) return [];
    return [{ text: text.trim().slice(0, 200), box: box_2d }];
  });

  if (raw.length > 0 && raw.every((l) => l.box.every((v) => v <= 1))) return null;
  if (raw.some((l) => l.box.some((v) => v > 1005 || v < -5))) return null;

  const clamp = (v: number) => Math.min(1000, Math.max(0, Math.round(v)));
  return raw
    .map((l) => ({ text: l.text, box: l.box.map(clamp) as Box }))
    .filter((l) => l.box[2] > l.box[0] && l.box[3] > l.box[1]);
}

export function isStoredLabels(value: unknown): value is StoredLabels {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { model?: unknown; labels?: unknown };
  return (
    typeof v.model === 'string' &&
    Array.isArray(v.labels) &&
    v.labels.every(
      (l) => typeof l === 'object' && l !== null && typeof (l as LabelBox).text === 'string' && isBox((l as LabelBox).box),
    )
  );
}

/** Words that say nothing about which label is meant. */
const STOPWORDS = new Set(
  (
    'a an the and or but of to in on at for with by from as into onto than then so ' +
    'is are was were be been being am it its this that these those there their they them ' +
    'which what who whom whose how why when where does do did done can could should would will shall may might must ' +
    'use used uses using also not no yes has have had each such like called known named one ones some any all ' +
    'your you we our he she his her i me my'
  ).split(' '),
);

const plain = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * A text's meaningful words, cut to their first five letters when long, so
 * "temporarily" finds the "Temporary" label and "registers" finds "Register".
 * The cut over-matches now and then ("internal" and "internet"); an extra label
 * covered is safe, and a missed one is not.
 */
function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of plain(text).split(' ')) {
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    out.add(word.length >= 6 ? word.slice(0, 5) : word);
  }
  return out;
}

/**
 * Which side a card's picture goes on, and what it covers.
 *
 * A label is covered when the answer names it and the question does not, or
 * when it shares a meaningful word with the answer that the question does not
 * use — so "Nucleus: holds the DNA" is covered for the answer "DNA". A label the
 * question names stays visible unless it carries part of the answer too.
 *
 *  - no trusted positions → with the answer;
 *  - nothing to cover → with the question, as it is: the answer is not on it;
 *  - most of the picture covered → with the answer.
 */
export function placePicture(input: {
  question: string;
  answer: string;
  labels: LabelBox[] | null;
}): PicturePlacement {
  const withAnswer: PicturePlacement = { side: 'answer', covers: [] };
  if (input.labels === null) return withAnswer;

  const asked = stems(input.question);
  const answerOnly = [...stems(input.answer)].filter((s) => !asked.has(s));
  const answerText = ` ${plain(input.answer)} `;
  const questionText = ` ${plain(input.question)} `;

  const covers = input.labels.filter((label) => {
    const own = stems(label.text);
    if (own.size === 0) return false;
    const named = ` ${plain(label.text)} `;
    if (answerText.includes(named) && !questionText.includes(named)) return true;
    return answerOnly.some((s) => own.has(s));
  });

  if (covers.length === 0) return { side: 'question', covers: [] };
  if (covers.length > Math.max(2, input.labels.length * MAX_COVERED_SHARE)) return withAnswer;
  return { side: 'question', covers };
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where to draw each cover, in the pixels of `area` — the part of the card the
 * picture is actually drawn in.
 *
 * Padded by nearly a third of the label's height on every side, and never less
 * than 3px: the measurement (NOTES §44.2) counted a label hidden only when a
 * cover a quarter of its height larger held every pixel of it. Kept inside the
 * picture, which never uncovers text that is inside it.
 */
export function coverRects(covers: LabelBox[], area: Rect): Rect[] {
  return covers.map(({ box: [ymin, xmin, ymax, xmax] }) => {
    const x0 = area.left + (xmin / 1000) * area.width;
    const x1 = area.left + (xmax / 1000) * area.width;
    const y0 = area.top + (ymin / 1000) * area.height;
    const y1 = area.top + (ymax / 1000) * area.height;
    const pad = Math.min(12, Math.max(3, (y1 - y0) * 0.3));
    const left = Math.max(area.left, x0 - pad);
    const top = Math.max(area.top, y0 - pad);
    const right = Math.min(area.left + area.width, x1 + pad);
    const bottom = Math.min(area.top + area.height, y1 + pad);
    return { left, top, width: right - left, height: bottom - top };
  });
}
