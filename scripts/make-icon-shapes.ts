/**
 * Writes src/core/icon-shapes.ts — the shapes of every icon the app draws.
 *
 *   npm pack lucide-static   (anywhere outside the repo, then untar it)
 *   npx tsx scripts/make-icon-shapes.ts --from <that folder>/package/icons
 *
 * The app draws its icons from Views (src/ui/glyphs.tsx), at the owner's choice
 * on 2026-09-28 over an icon package or plain SVG (NOTES §56.2). The shapes are
 * Lucide's, copied under its ISC licence, whose notice travels with them in the
 * written file. Lucide is NOT a dependency: this script reads a folder you
 * downloaded, and nothing in the app imports it.
 *
 * Circles, rectangles and lines are kept as themselves, because a View draws
 * each of those in one piece. Everything else becomes a path, which
 * src/core/icon-geometry.ts turns into straight pieces.
 *
 * Nomi's owl is not Lucide's — there is no owl — and is written out below in
 * the same 24-unit box.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const from = process.argv[process.argv.indexOf('--from') + 1];
if (!process.argv.includes('--from') || !from) {
  console.error('usage: npx tsx scripts/make-icon-shapes.ts --from <lucide-static>/package/icons');
  process.exit(1);
}

/** Our name → Lucide's file. The name says what it is FOR, not what it looks like. */
const LUCIDE: Record<string, string> = {
  search: 'search',
  // The paper plane: sending, and — as every messenger has it — your messages.
  send: 'send',
  compose: 'square-pen',
  edit: 'pencil',
  settings: 'settings',
  more: 'ellipsis',
  back: 'chevron-left',
  forward: 'chevron-right',
  down: 'chevron-down',
  close: 'x',
  plus: 'plus',
  check: 'check',
  heart: 'heart',
  comment: 'message-circle',
  share: 'share',
  bookmark: 'bookmark',
  photo: 'image',
  camera: 'camera',
  set: 'copy',
  streak: 'flame',
  emoji: 'smile',
  people: 'users',
  person: 'user',
  addFriend: 'user-plus',
  everyone: 'globe',
  lock: 'lock',
  reply: 'reply',
  trash: 'trash-2',
  report: 'triangle-alert',
  block: 'ban',
  hide: 'eye-off',
  notes: 'file-text',
  progress: 'chart-no-axes-column-increasing',
  link: 'link',
  recent: 'history',
  star: 'star',
  folder: 'folder',
  up: 'arrow-up',
  moderation: 'shield',
};

type Shape =
  | ['p', string]
  | ['c', number, number, number]
  | ['r', number, number, number, number, number]
  | ['l', number, number, number, number];

/**
 * Nomi's owl: ear tufts, a round body, two big eyes with pupils, a beak.
 * Drawn for this app in Lucide's box and stroke so it sits in the tab bar
 * beside the others.
 */
const OWL: Shape[] = [
  ['p', 'M4 4 8 7h8l4-3v9a8 8 0 0 1-16 0z'],
  ['c', 9, 12.5, 2.5],
  ['c', 15, 12.5, 2.5],
  ['l', 9, 12.5, 9, 12.5],
  ['l', 15, 12.5, 15, 12.5],
  ['p', 'm11 16.2 1 1.4 1-1.4'],
];

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Digits too: a line's ends are x1, y1, x2, y2. Without them every line
  // landed at 0,0 as a dot in the corner, which the first photograph showed.
  for (const m of tag.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

function shapesOf(file: string): Shape[] {
  const svg = readFileSync(join(from!, `${file}.svg`), 'utf8');
  const shapes: Shape[] = [];
  for (const m of svg.matchAll(/<(path|circle|rect|line|ellipse|polyline|polygon)\b([^>]*)\/?>/g)) {
    const [, tag, rest] = m;
    const a = attrs(rest!);
    const required: Record<string, string[]> = {
      path: ['d'],
      circle: ['r'],
      rect: ['width', 'height'],
      line: ['x1', 'y1', 'x2', 'y2'],
      ellipse: ['rx', 'ry'],
      polyline: ['points'],
      polygon: ['points'],
    };
    for (const k of required[tag!]!) if (a[k] === undefined) throw new Error(`${file}.svg: <${tag}> has no ${k}`);
    const n = (k: string, d = 0) => (a[k] === undefined ? d : Number(a[k]));
    if (tag === 'path') shapes.push(['p', a.d!]);
    else if (tag === 'circle') shapes.push(['c', n('cx'), n('cy'), n('r')]);
    else if (tag === 'rect') shapes.push(['r', n('x'), n('y'), n('width'), n('height'), n('rx', n('ry'))]);
    else if (tag === 'line') shapes.push(['l', n('x1'), n('y1'), n('x2'), n('y2')]);
    else if (tag === 'ellipse') {
      const [cx, cy, rx, ry] = [n('cx'), n('cy'), n('rx'), n('ry')];
      shapes.push(['p', `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`]);
    } else {
      const pts = a.points!.trim();
      shapes.push(['p', `M${pts}${tag === 'polygon' ? 'z' : ''}`]);
    }
  }
  if (!shapes.length) throw new Error(`${file}.svg: no shapes found`);
  return shapes;
}

const all: Record<string, Shape[]> = { nomi: OWL };
for (const [name, file] of Object.entries(LUCIDE)) all[name] = shapesOf(file);

const licence = readFileSync(join(from!, '..', 'LICENSE'), 'utf8').trim();
const version = JSON.parse(readFileSync(join(from!, '..', 'package.json'), 'utf8')).version as string;

const body = Object.entries(all)
  .map(([name, shapes]) => `  ${name}: [\n${shapes.map((s) => `    ${JSON.stringify(s)},`).join('\n')}\n  ],`)
  .join('\n');

writeFileSync(
  'src/core/icon-shapes.ts',
  `/**
 * GENERATED by scripts/make-icon-shapes.ts from lucide-static ${version} — do
 * not edit by hand; change the script and run it again.
 *
 * Every icon the app draws, in a 24-unit box, as the shapes a stroke follows:
 * ['p', path] · ['c', cx, cy, r] · ['r', x, y, width, height, corner] ·
 * ['l', x1, y1, x2, y2]. src/core/icon-geometry.ts turns them into straight
 * pieces and src/ui/glyphs.tsx draws those as Views (NOTES §56.2).
 *
 * \`nomi\` is drawn for this app. The rest are Lucide's (https://lucide.dev),
 * under this notice:
 *
${licence
  .split('\n')
  .map((l) => ` * ${l}`.trimEnd())
  .join('\n')}
 */

export type IconShape =
  | readonly ['p', string]
  | readonly ['c', number, number, number]
  | readonly ['r', number, number, number, number, number]
  | readonly ['l', number, number, number, number];

export const ICON_SHAPES = {
${body}
} as const satisfies Record<string, readonly IconShape[]>;

export type IconName = keyof typeof ICON_SHAPES;
`,
);
console.log(`wrote src/core/icon-shapes.ts: ${Object.keys(all).length} icons, lucide-static ${version}`);
