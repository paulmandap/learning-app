/**
 * Rich notes: the editor's document, and the plain text everything else reads
 * (NOTES §43).
 *
 * Pure. The note editor (Tiptap, on the web) keeps a note as a document —
 * paragraphs, headings, lists, pictures — saved in `notes.content`. Everything
 * that existed before still reads `notes.body`: making cards, the Notes list's
 * title and preview, the word count. So every save also writes the document down
 * as plain text with `docToText`, in the shapes the card-maker already reads
 * well — "# " headings and "- " list lines, which the planner counts as a card's
 * worth each.
 *
 * Pictures are kept by their PATH in the private `note-images` bucket, never by
 * a link: a signed link expires within the hour, a path does not.
 * `withImageSources` adds fresh links for showing; `forStorage` takes them off
 * again before saving.
 *
 * The node names are Tiptap's (ProseMirror's JSON), and this file imports
 * nothing from it: a note saved by any version of the editor is plain JSON here.
 */

export interface RichMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface RichNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichNode[];
  text?: string;
  marks?: RichMark[];
}

export interface RichDoc extends RichNode {
  type: 'doc';
  content: RichNode[];
}

/** Most pictures one note holds. Each becomes a document read by Gemini when cards are made. */
export const MAX_NOTE_IMAGES = 12;

/** A picture's longest side after it is shrunk on the phone, before upload. */
export const NOTE_IMAGE_MAX_SIDE = 1600;

/** Anything read back from the database that is shaped like a document. */
export function isRichDoc(value: unknown): value is RichDoc {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'doc' &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function emptyDoc(): RichDoc {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

// ------------------------------------------------------------ doc -> text --

function inlineText(node: RichNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? []).map(inlineText).join('');
}

function blocks(nodes: readonly RichNode[]): string[] {
  return nodes.flatMap(linesOf);
}

/** A list item's lines, the first behind its marker and the rest indented under it. */
function itemLines(item: RichNode, marker: string): string[] {
  const inner = blocks(item.content ?? []).filter((line) => line.trim().length > 0);
  if (inner.length === 0) return [];
  const pad = ' '.repeat(marker.length);
  return inner.map((line, i) => (i === 0 ? marker + line : pad + line));
}

function linesOf(node: RichNode): string[] {
  switch (node.type) {
    case 'paragraph':
      return inlineText(node).split('\n');
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      const text = inlineText(node).replace(/\s+/g, ' ').trim();
      return text ? [`${'#'.repeat(level)} ${text}`] : [];
    }
    case 'bulletList':
      return (node.content ?? []).flatMap((item) => itemLines(item, '- '));
    case 'orderedList': {
      const start = Number(node.attrs?.start) || 1;
      return (node.content ?? []).flatMap((item, i) => itemLines(item, `${start + i}. `));
    }
    case 'taskList':
      return (node.content ?? []).flatMap((item) => itemLines(item, item.attrs?.checked ? '- [x] ' : '- [ ] '));
    case 'blockquote':
      return blocks(node.content ?? []).map((line) => (line ? `> ${line}` : '>'));
    case 'codeBlock':
      return inlineText(node).split('\n');
    // A picture has no words to make cards from here; its pixels go to Gemini
    // as a document of their own when cards are made (src/data/start-set.ts).
    case 'image':
    case 'horizontalRule':
      return [];
    default:
      return node.content ? blocks(node.content) : node.text ? node.text.split('\n') : [];
  }
}

/** The note as plain text, for `notes.body` — what cards, previews and word counts read. */
export function docToText(doc: RichDoc): string {
  return blocks(doc.content)
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------ text -> doc --

const textNode = (text: string): RichNode[] => (text.length > 0 ? [{ type: 'text', text }] : []);
const paragraph = (text: string): RichNode => {
  const content = textNode(text);
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
};

/**
 * A note written before the editor, as a document to open it in.
 *
 * Only the shapes a person types without an editor: "# " headings, "- " or
 * "* " or "• " bullets, "1. " numbered lines, and paragraphs. Nothing is lost:
 * anything else is a paragraph with its text exactly as written.
 */
export function textToDoc(body: string): RichDoc {
  const content: RichNode[] = [];
  let list: RichNode | null = null;

  const listItem = (text: string): RichNode => ({ type: 'listItem', content: [paragraph(text)] });

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.+)$/.exec(line);
    const numbered = /^\s*(\d{1,3})[.)]\s+(.+)$/.exec(line);

    if (bullet) {
      if (list?.type !== 'bulletList') content.push((list = { type: 'bulletList', content: [] }));
      list.content!.push(listItem(bullet[1]!));
      continue;
    }
    if (numbered) {
      if (list?.type !== 'orderedList') {
        content.push((list = { type: 'orderedList', attrs: { start: Number(numbered[1]) }, content: [] }));
      }
      list.content!.push(listItem(numbered[2]!));
      continue;
    }
    list = null;
    if (heading) {
      content.push({ type: 'heading', attrs: { level: heading[1]!.length }, content: textNode(heading[2]!) });
    } else {
      content.push(paragraph(line));
    }
  }

  // No run of empty paragraphs longer than one, and never an empty document.
  const tidy = content.filter(
    (node, i) => !(isEmptyParagraph(node) && (i === 0 || isEmptyParagraph(content[i - 1]!))),
  );
  while (tidy.length > 0 && isEmptyParagraph(tidy[tidy.length - 1]!)) tidy.pop();
  return { type: 'doc', content: tidy.length > 0 ? tidy : [{ type: 'paragraph' }] };
}

function isEmptyParagraph(node: RichNode): boolean {
  return node.type === 'paragraph' && (node.content ?? []).length === 0;
}

// ---------------------------------------------------------------- pictures --

function mapImages(node: RichNode, fn: (image: RichNode) => RichNode): RichNode {
  const next = node.type === 'image' ? fn(node) : node;
  return next.content ? { ...next, content: next.content.map((child) => mapImages(child, fn)) } : next;
}

/** Every stored picture in a note, in order, each once. */
export function imagePaths(doc: RichDoc): string[] {
  const out: string[] = [];
  const walk = (node: RichNode) => {
    const path = node.type === 'image' ? node.attrs?.path : undefined;
    if (typeof path === 'string' && path.length > 0 && !out.includes(path)) out.push(path);
    node.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

/** The document with a fresh link on every stored picture, for showing it. */
export function withImageSources(doc: RichDoc, urls: Readonly<Record<string, string>>): RichDoc {
  return mapImages(doc, (image) => {
    const path = image.attrs?.path;
    return typeof path === 'string' ? { ...image, attrs: { ...image.attrs, src: urls[path] ?? '' } } : image;
  }) as RichDoc;
}

/**
 * The document as it is saved: stored pictures keep their path and lose their
 * link, which would be expired by the time anyone opened the note again. A
 * picture with no path was never uploaded and is not kept.
 */
export function forStorage(doc: RichDoc): RichDoc {
  const strip = (node: RichNode): RichNode | null => {
    if (node.type === 'image') {
      const path = node.attrs?.path;
      if (typeof path !== 'string' || path.length === 0) return null;
      const { src: _src, ...attrs } = node.attrs ?? {};
      return { ...node, attrs };
    }
    if (!node.content) return node;
    return { ...node, content: node.content.map(strip).filter((child): child is RichNode => child !== null) };
  };
  return strip(doc) as RichDoc;
}

/** Where an uploaded picture goes: `<user>/<note>/image-<time>.jpg`, the owner's folder first, as the bucket's policies require. */
export function noteImagePath(userId: string, noteId: string, now: number): string {
  return `${userId}/${noteId}/image-${now}.jpg`;
}
