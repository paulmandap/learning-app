/**
 * The Q:A keeper: questions the student already wrote, kept exactly as written
 * (NOTES §49).
 *
 * Pure. No react-native, no database, no model.
 *
 * ## Why this exists
 *
 * The owner, 2026-09-23: *"there is a time when i make a flashcard, i already
 * have the format in my notes for the Question:Answer yet it's still getting
 * reworded."* It was not a glitch. The generation prompt says WRITE IN YOUR OWN
 * WORDS and, of notes that are already a quiz, "do not copy it" — a rule kept on
 * purpose for ordinary notes, where an answer copied out of prose comes back as
 * a paragraph (NOTES §9). For a card the student has already written, it is
 * simply wrong.
 *
 * So those cards are not written at all. Code reads them out of the notes and
 * Gemini is never asked. A prompt rule saying "keep their wording" would be a
 * wish; a card that never passes through a model cannot be reworded.
 *
 * ## Whatever the format
 *
 * The owner: *"nomi must be able to identify it whichever format it may
 * serve."* Six shapes, tried strongest first, each line belonging to at most
 * one pair:
 *
 *  1. **Labelled** — `Q:` / `A:`, `Question:` / `Answer:`, `Tanong:` / `Sagot:`,
 *     numbered or not, on one line or two, the answer running on until a blank
 *     line. Also a question whose answer alone is labelled. A label is the
 *     student saying "this is a card", so ONE counts.
 *  2. **Tables** with two columns — how the reader returns a Q&A page from a
 *     PDF or a photo — headed like one ("Question | Answer", "Term |
 *     Definition"), or with questions down the first column.
 *  3. **One line**: `What is osmosis? : Water moving across a membrane`, or with
 *     `-`, `–`, `—`, `=`, `->`.
 *  4. **Alternating labels** the list above does not know — `Frage:` /
 *     `Antwort:` — when the first of the two asks the questions.
 *  5. **A question, then its answer on the next line**, no labels.
 *  6. **`Term: definition`**, the card asking the term.
 *
 * The last four carry no label saying "this is a card", and each has an
 * innocent twin: prose with a rhetorical question, a speaker's lines in a play,
 * `Note: exam on Friday`. So they count only when the shape REPEATS —
 * `MIN_REPEATS` times on the page — and the two loosest (5 and 6) only when
 * they are most of what is left of it (`MIN_SHARE`).
 *
 * A multiple-choice question is never a pair: `A.` followed by `B.` is a list
 * of options, and the card-writer already knows what to do with a quiz.
 *
 * Anything still in a layout none of these reads is Gemini's to POINT at
 * (`locatePointed`): it names the pairs, and code keeps one only if both halves
 * are found in the notes — and then keeps the notes' own characters, never the
 * model's.
 */

import { normalize, normalizeWithMap, splitSentences } from './text';
import { lineKey } from './coverage';
import type { Level } from './planner';
import type { ValidatedItem } from './validate';

export type QaShape = 'labelled' | 'table' | 'one_line' | 'alternating' | 'next_line' | 'term' | 'pointed';

export interface QaPair {
  /** As written, with only its label ("Q:") and numbering ("1.") taken off. */
  question: string;
  /** As written, with only its label ("A:") taken off. Lines kept as lines. */
  answer: string;
  shape: QaShape;
  /** The page's lines — `text.split(/\r?\n/)` — that the pair covers, inclusive. */
  fromLine: number;
  toLine: number;
  /** The nearest heading above it, without its `#`s. */
  heading: string | null;
}

/** Where a pointed pair's halves are in the page text, as [start, end) character offsets. */
export interface QaSpan {
  q: [number, number];
  a: [number, number];
}

/** An unlabelled shape counts only when it appears this many times on a page. */
export const MIN_REPEATS = 3;

/**
 * And the two loosest — a question with its answer on the next line, and
 * `Term: definition` — only when they cover this much of what is left of the
 * page. Measured in lines: a pasted paragraph is one line however long, which
 * leans generous toward a glossary with an introduction above it.
 */
export const MIN_SHARE = 0.5;

// --- the shapes of a line -----------------------------------------------------

const HEADING = /^#{1,6}\s+\S/;

/** "1.", "2)", "(3)", "4 -", and bullets. Never a letter: "A." is an option or an answer. */
const NUMBERING = /^(?:\(?\d{1,3}[.)]|\d{1,3}\s*[-–—](?=\s)|[-*•‣▪◦–])\s+/;

const Q_LABEL = /^(?:q|ques|question|tanong)\s*#?\s*\d{0,3}\s*[:.)\-–—]\s*/i;

/** "A:", "Ans:", "Answer:", "Sagot:" — and, for the words, "Ans." or "Answer -" as well. */
const A_LABEL = /^(?:(?:a|ans|answer|sagot)\s*#?\s*\d{0,3}\s*:|(?:ans|answer|sagot)\s*#?\s*\d{0,3}\s*[.)\-–—])\s*/i;

/** "A." or "A)" — an answer, unless a "B." follows it and it is the first of some options. */
const A_LETTER = /^a\s*[.)]\s*/i;
const OPTION = /^[a-e]\s*[.)]\s+\S/i;
const OPTION_B = /^b\s*[.)]\s+\S/i;

/** "Q: What is it? A: This." — a labelled question answered on the same line. */
const INLINE_ANSWER = /^(.*?\?)\s*(?:a|ans|answer|sagot)\s*#?\s*\d{0,3}\s*[:.)\-–—]\s*(\S.*)$/i;
/** "… A) cats B) dogs" — options on one line, which is a quiz, not an answer. */
const INLINE_OPTIONS = /\s[b-e]\s*[.)]\s+\S/i;

/** "What is osmosis? : Water …" and the other separators. */
const ONE_LINE = /^(.*?\?)\s*(?::|=>|->|→|=|[-–—])\s*(\S.*)$/;

/**
 * "Term: definition" or "Term - definition". The colon needs a space or the end
 * of the line after it, so "10:30" and "https://" are not terms.
 */
const TERM = /^([^:?]{1,60}?)(?:\s*:(?:\s+|$)|\s+[-–—]\s+)(.*)$/;
const MAX_TERM_WORDS = 6;

/** Housekeeping that looks like a glossary entry and never is one. */
const NOT_A_TERM = new Set([
  'note', 'notes', 'nb', 'n.b', 'example', 'examples', 'e.g', 'eg', 'ex', 'date', 'time', 'day', 'topic',
  'subject', 'name', 'teacher', 'instructor', 'professor', 'prof', 'section', 'room', 'class', 'course',
  'lesson', 'unit', 'module', 'chapter', 'page', 'pages', 'source', 'sources', 'reference', 'references',
  'ref', 'tip', 'tips', 'remember', 'reminder', 'important', 'warning', 'caution', 'hint', 'answer',
  'answers', 'question', 'questions', 'direction', 'directions', 'instruction', 'instructions', 'title',
  'score', 'total', 'due', 'deadline', 'quiz', 'exam', 'test', 'assignment', 'homework', 'summary',
  'conclusion', 'introduction', 'objective', 'objectives', 'goal', 'goals', 'key points', 'paalala',
  'halimbawa', 'petsa', 'pangalan', 'paksa', 'guro', 'tandaan', 'araw', 'oras',
  // The labels themselves, when one is left over without its partner.
  'q', 'a', 'ans', 'ques', 'tanong', 'sagot',
]);

/** A line labelled with anything: "Frage: Was ist …?" */
const ANY_LABEL = /^(\p{L}[\p{L}\p{N} .'-]{0,20}?)\s*:\s*(\S.*)$/u;

const TABLE_ROW = /^\|(.+)\|\s*$/;
const TABLE_RULE = /^:?-{3,}:?$/;
const Q_HEADER = /^(?:q|questions?|terms?|words?|concepts?|keywords?|tanong|salita)$/i;
const A_HEADER = /^(?:a|answers?|definitions?|meanings?|descriptions?|explanations?|sagot|kahulugan)$/i;

const HAS_LETTER = /\p{L}/u;

// --- the page, as lines ---------------------------------------------------------

interface Page {
  lines: string[];
  /** Each line, trimmed. */
  t: string[];
  claimed: boolean[];
  headings: ReadonlySet<string>;
}

/** A pair not yet placed under its heading. */
type Draft = Omit<QaPair, 'heading'>;

const unnumber = (s: string) => s.replace(NUMBERING, '');
const unhash = (s: string) => s.replace(/^#{1,6}\s+/, '').trim();

function isHeading(page: Page, i: number): boolean {
  const s = page.t[i]!;
  return s.length > 0 && (HEADING.test(s) || (page.headings.size > 0 && page.headings.has(normalize(unhash(s)))));
}

const isBlank = (page: Page, i: number) => page.t[i]!.length === 0;

/** Lines that are neither blank nor a heading, and not yet part of a pair. */
function freeContent(page: Page): number {
  let n = 0;
  for (let i = 0; i < page.t.length; i++) if (!page.claimed[i] && !isBlank(page, i) && !isHeading(page, i)) n++;
  return n;
}

/** The next line with something on it, or -1. */
function nextFilled(page: Page, from: number): number {
  for (let j = from; j < page.t.length; j++) if (!isBlank(page, j)) return j;
  return -1;
}

/** Does "A." at line j start a list of options — is the next filled line "B."? */
function optionsFollow(page: Page, j: number): boolean {
  const k = nextFilled(page, j + 1);
  return k >= 0 && OPTION_B.test(page.t[k]!);
}

/**
 * The lines that carry an answer on, after its first: until a blank line, a
 * heading, a new label, or a line already taken. `stopAtQuestion` also ends it
 * at the next line asking something — for shapes whose next question is
 * unlabelled.
 */
function runOn(page: Page, from: number, stopAtQuestion: boolean): number[] {
  const out: number[] = [];
  for (let j = from; j < page.t.length; j++) {
    const s = page.t[j]!;
    if (s.length === 0 || page.claimed[j] || isHeading(page, j)) break;
    const bare = unnumber(s);
    if (Q_LABEL.test(bare) || A_LABEL.test(s) || OPTION.test(s)) break;
    if (stopAtQuestion && bare.endsWith('?')) break;
    out.push(j);
  }
  return out;
}

function claim(page: Page, drafts: readonly Draft[]): void {
  for (const d of drafts) for (let i = d.fromLine; i <= d.toLine; i++) page.claimed[i] = true;
}

const joined = (page: Page, first: string, rest: readonly number[]) =>
  [first, ...rest.map((j) => page.t[j]!)].filter((s) => s.length > 0).join('\n').trim();

const usable = (d: Draft) => HAS_LETTER.test(d.question) && d.answer.trim().length > 0;

// --- 1. labelled -----------------------------------------------------------------

function labelled(page: Page): Draft[] {
  const out: Draft[] = [];
  const n = page.t.length;

  for (let i = 0; i < n; i++) {
    if (page.claimed[i] || isBlank(page, i) || isHeading(page, i)) continue;
    const head = unnumber(page.t[i]!);
    const q = Q_LABEL.exec(head);

    // A question with no label of its own, whose answer is labelled.
    if (!q) {
      if (!head.endsWith('?')) continue;
      const k = nextFilled(page, i + 1);
      if (k < 0 || k - i > 2 || page.claimed[k]) continue;
      const a = A_LABEL.exec(page.t[k]!);
      if (!a) continue;
      const more = runOn(page, k + 1, false);
      const d: Draft = {
        question: head,
        answer: joined(page, page.t[k]!.slice(a[0].length).trim(), more),
        shape: 'labelled',
        fromLine: i,
        toLine: more.length > 0 ? more[more.length - 1]! : k,
      };
      if (usable(d)) {
        out.push(d);
        claim(page, [d]);
      }
      continue;
    }

    const rest = head.slice(q[0].length).trim();

    // Answered on the same line.
    const inline = INLINE_ANSWER.exec(rest);
    if (inline && !INLINE_OPTIONS.test(` ${inline[2]!}`)) {
      const more = runOn(page, i + 1, false);
      const d: Draft = {
        question: inline[1]!.trim(),
        answer: joined(page, inline[2]!.trim(), more),
        shape: 'labelled',
        fromLine: i,
        toLine: more.length > 0 ? more[more.length - 1]! : i,
      };
      if (usable(d)) {
        out.push(d);
        claim(page, [d]);
      }
      continue;
    }

    // The question may run on over lines; the answer is the next answer label —
    // or, once the question has ended with "?", simply the next line.
    const question: string[] = rest ? [rest] : [];
    let blanks = 0;
    let options = false;
    let answerAt = -1;
    let first = '';
    for (let j = i + 1; j < n; j++) {
      const s = page.t[j]!;
      if (s.length === 0) {
        if (++blanks > 1) break;
        continue;
      }
      if (page.claimed[j] || isHeading(page, j) || Q_LABEL.test(unnumber(s))) break;
      const a = A_LABEL.exec(s);
      if (a) {
        answerAt = j;
        first = s.slice(a[0].length).trim();
        break;
      }
      if (A_LETTER.test(s) && !optionsFollow(page, j)) {
        answerAt = j;
        first = s.replace(A_LETTER, '').trim();
        break;
      }
      if (OPTION.test(s)) {
        options = true;
        continue;
      }
      if (options) continue;
      if (question.join(' ').trim().endsWith('?')) {
        answerAt = j;
        first = s;
        break;
      }
      if (blanks > 0) break;
      question.push(s);
    }

    // A multiple-choice question stays with the card-writer, which knows what to
    // do with a quiz. So does a question nobody answered.
    if (options || answerAt < 0) continue;
    const more = runOn(page, answerAt + 1, false);
    const d: Draft = {
      question: question.join('\n').trim(),
      answer: joined(page, first, more),
      shape: 'labelled',
      fromLine: i,
      toLine: more.length > 0 ? more[more.length - 1]! : answerAt,
    };
    if (usable(d)) {
      out.push(d);
      claim(page, [d]);
    }
  }
  return out;
}

// --- 2. tables -------------------------------------------------------------------

function cells(row: string): string[] {
  const m = TABLE_ROW.exec(row);
  return m ? m[1]!.split('|').map((c) => c.trim()) : [];
}

function tables(page: Page): Draft[] {
  const out: Draft[] = [];
  const n = page.t.length;
  let i = 0;
  while (i < n) {
    if (page.claimed[i] || !TABLE_ROW.test(page.t[i]!)) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < n && !page.claimed[end + 1] && TABLE_ROW.test(page.t[end + 1]!)) end++;

    const rows = [];
    for (let j = i; j <= end; j++) rows.push({ line: j, cells: cells(page.t[j]!) });
    const twoColumns = rows.every((r) => r.cells.length === 2);
    const ruled = rows.length >= 2 && rows[1]!.cells.every((c) => TABLE_RULE.test(c));
    const header = ruled ? rows[0]!.cells : null;
    const data = (ruled ? rows.slice(2) : rows).filter((r) => r.cells[0] && r.cells[1]);

    const headedAsQa = header !== null && Q_HEADER.test(header[0]!) && A_HEADER.test(header[1]!);
    const asking = data.filter((r) => r.cells[0]!.endsWith('?')).length;
    const questionsDown = data.length >= MIN_REPEATS && asking * 3 >= data.length * 2;

    if (twoColumns && data.length > 0 && (headedAsQa || questionsDown)) {
      const drafts = data
        .map((r): Draft => ({
          question: r.cells[0]!,
          answer: r.cells[1]!,
          shape: 'table',
          fromLine: r.line,
          toLine: r.line,
        }))
        .filter(usable);
      out.push(...drafts);
      for (let j = i; j <= end; j++) page.claimed[j] = true;
    }
    i = end + 1;
  }
  return out;
}

// --- 3. one line -------------------------------------------------------------------

function oneLine(page: Page): Draft[] {
  const found: Draft[] = [];
  for (let i = 0; i < page.t.length; i++) {
    if (page.claimed[i] || isBlank(page, i) || isHeading(page, i)) continue;
    const m = ONE_LINE.exec(unnumber(page.t[i]!));
    if (!m) continue;
    const d: Draft = { question: m[1]!.trim(), answer: m[2]!.trim(), shape: 'one_line', fromLine: i, toLine: i };
    if (usable(d)) found.push(d);
  }
  if (found.length < MIN_REPEATS) return [];
  claim(page, found);
  return found;
}

// --- 4. alternating labels ------------------------------------------------------------

function alternating(page: Page): Draft[] {
  const out: Draft[] = [];
  const n = page.t.length;

  // Runs of labelled lines, blank lines allowed between them — each line read
  // once. Within a run, alternation is tried from each place the label
  // changes, so a stray "Note:" above the questions does not hide them; a
  // stretch that alternates but is not asking questions — a play's two
  // speakers — is tried with its roles both ways round, then passed over
  // whole, so a long script costs one look rather than one per line.
  let i = 0;
  while (i < n) {
    const run: { line: number; label: string; text: string }[] = [];
    let j = i;
    for (; j < n; j++) {
      if (isBlank(page, j)) continue;
      if (page.claimed[j] || isHeading(page, j)) break;
      const m = ANY_LABEL.exec(unnumber(page.t[j]!));
      if (!m) break;
      run.push({ line: j, label: normalize(m[1]!), text: m[2]!.trim() });
    }
    i = Math.max(j, i + 1);

    let k = 0;
    let swapped = false;
    while (k + 1 < run.length) {
      const [askLabel, answerLabel] = [run[k]!.label, run[k + 1]!.label];
      if (askLabel === answerLabel) {
        k++;
        continue;
      }
      const drafts: Draft[] = [];
      for (let m = k; m + 1 < run.length; m += 2) {
        if (run[m]!.label !== askLabel || run[m + 1]!.label !== answerLabel) break;
        drafts.push({
          question: run[m]!.text,
          answer: run[m + 1]!.text,
          shape: 'alternating',
          fromLine: run[m]!.line,
          toLine: run[m + 1]!.line,
        });
      }
      const asking = drafts.filter((d) => d.question.endsWith('?')).length;
      if (drafts.length >= MIN_REPEATS && asking * 3 >= drafts.length * 2) {
        const kept = drafts.filter(usable);
        out.push(...kept);
        claim(page, kept);
        k += drafts.length * 2;
        swapped = false;
      } else if (drafts.length <= 1) {
        // A pair at most: the alternation starts later, if anywhere.
        k += 1;
        swapped = false;
      } else if (!swapped) {
        k += 1;
        swapped = true;
      } else {
        k += drafts.length * 2 - 1;
        swapped = false;
      }
    }
  }
  return out;
}

// --- 5. a question, then its answer ------------------------------------------------------

function nextLine(page: Page): Draft[] {
  const content = freeContent(page);
  const found: Draft[] = [];
  const n = page.t.length;

  for (let i = 0; i < n; i++) {
    if (page.claimed[i] || isBlank(page, i) || isHeading(page, i)) continue;
    const question = unnumber(page.t[i]!);
    if (!question.endsWith('?') || Q_LABEL.test(question) || OPTION.test(question)) continue;

    const k = nextFilled(page, i + 1);
    if (k < 0 || k - i > 2 || page.claimed[k] || isHeading(page, k)) continue;
    const answer = runOn(page, k, true);
    if (answer.length === 0) continue;

    const d: Draft = {
      question,
      answer: answer.map((j) => page.t[j]!).join('\n'),
      shape: 'next_line',
      fromLine: i,
      toLine: answer[answer.length - 1]!,
    };
    if (!usable(d)) continue;
    found.push(d);
    i = d.toLine;
  }

  // Judged on the question and the FIRST line of each answer. An answer runs on
  // to the next blank line, and in prose with no blank lines that is every line
  // up to the next question — so measuring whole answers would let three
  // rhetorical questions claim a page of prose as theirs.
  const covered = found.length * 2;
  if (found.length < MIN_REPEATS || covered < content * MIN_SHARE) return [];
  claim(page, found);
  return found;
}

// --- 6. term: definition --------------------------------------------------------------------

function termOf(line: string): { term: string; definition: string } | null {
  const m = TERM.exec(unnumber(line));
  if (!m) return null;
  const term = m[1]!.trim();
  if (!HAS_LETTER.test(term) || term.split(/\s+/).length > MAX_TERM_WORDS) return null;
  if (NOT_A_TERM.has(term.toLowerCase().replace(/[.]+$/, ''))) return null;
  return { term, definition: m[2]!.trim() };
}

function terms(page: Page): Draft[] {
  const content = freeContent(page);
  const found: Draft[] = [];
  const n = page.t.length;

  // A glossary names each term once. A "term" on several lines is a label —
  // a speaker in a script, "Frage:" over and over — and never a card.
  const uses = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (page.claimed[i]) continue;
    const entry = termOf(page.t[i]!);
    if (entry) uses.set(normalize(entry.term), (uses.get(normalize(entry.term)) ?? 0) + 1);
  }

  for (let i = 0; i < n; i++) {
    if (page.claimed[i] || isBlank(page, i) || isHeading(page, i)) continue;
    const entry = termOf(page.t[i]!);
    if (!entry || (uses.get(normalize(entry.term)) ?? 0) > 1) continue;

    // "Osmosis:" alone on its line, its meaning below it.
    let toLine = i;
    let definition = entry.definition;
    if (!definition) {
      const below: number[] = [];
      for (let j = i + 1; j < n; j++) {
        if (isBlank(page, j) || page.claimed[j] || isHeading(page, j) || termOf(page.t[j]!)) break;
        below.push(j);
      }
      if (below.length === 0) continue;
      definition = below.map((j) => page.t[j]!).join('\n');
      toLine = below[below.length - 1]!;
    }
    const d: Draft = { question: entry.term, answer: definition, shape: 'term', fromLine: i, toLine };
    if (!usable(d)) continue;
    found.push(d);
    i = toLine;
  }

  const covered = found.reduce((sum, d) => sum + linesIn(page, d), 0);
  if (found.length < MIN_REPEATS || covered < content * MIN_SHARE) return [];
  claim(page, found);
  return found;
}

function linesIn(page: Page, d: Draft): number {
  let n = 0;
  for (let i = d.fromLine; i <= d.toLine; i++) if (!isBlank(page, i)) n++;
  return n;
}

// --- all of it ------------------------------------------------------------------------------------

function readPage(text: string, headings: readonly string[]): Page {
  const lines = text.split(/\r?\n/);
  return {
    lines,
    t: lines.map((l) => l.trim()),
    claimed: lines.map(() => false),
    headings: new Set(headings.map((h) => normalize(unhash(h))).filter((h) => h.length > 0)),
  };
}

function headingAbove(page: Page, line: number): string | null {
  for (let i = line - 1; i >= 0; i--) if (isHeading(page, i)) return unhash(page.t[i]!);
  return null;
}

/** The heading above every line, in one pass — asked per pair, a long page would be read once per pair. */
function headingsAbove(page: Page): (string | null)[] {
  const out: (string | null)[] = [];
  let current: string | null = null;
  for (let i = 0; i < page.t.length; i++) {
    out.push(current);
    if (isHeading(page, i)) current = unhash(page.t[i]!);
  }
  return out;
}

/**
 * Every question-and-answer pair on a page, in reading order.
 *
 * `headings` are the page's own, when the reader found them — a PDF's headings
 * are plain lines in its text, and a heading is never a question or an answer.
 */
export function findQaPairs(text: string, headings: readonly string[] = []): QaPair[] {
  const page = readPage(text, headings);
  const drafts = [
    ...labelled(page),
    ...tables(page),
    ...oneLine(page),
    ...alternating(page),
    ...nextLine(page),
    ...terms(page),
  ];
  const above = headingsAbove(page);
  return drafts.sort((a, b) => a.fromLine - b.fromLine).map((d) => ({ ...d, heading: above[d.fromLine] ?? null }));
}

/**
 * Do these notes look like questions and answers that `findQaPairs` could not
 * read? Then — and only then — Gemini is asked to point at them.
 *
 * Deliberately narrow: many lines asking something, making up a real share of
 * the page, most of them with no pair found. Prose that asks the odd rhetorical
 * question stays with the card-writer.
 */
export function looksLikeQa(text: string, found: readonly QaPair[], headings: readonly string[] = []): boolean {
  const page = readPage(text, headings);
  let content = 0;
  let asking = 0;
  for (let i = 0; i < page.t.length; i++) {
    if (isBlank(page, i) || isHeading(page, i)) continue;
    content++;
    if (page.t[i]!.includes('?')) asking++;
  }
  return asking >= MIN_REPEATS && asking * 4 >= content && found.length * 2 < asking;
}

// --- what Gemini points at ------------------------------------------------------------------------

/** Line index of each character offset's line. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The end of the line an offset sits on, before any "\r". */
function lineEnd(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset);
  const end = nl < 0 ? text.length : nl;
  return end > 0 && text[end - 1] === '\r' ? end - 1 : end;
}

/** A pointed half's own words, with any label or numbering Gemini carried along taken off. */
function stripQuestion(s: string): string {
  return unnumber(s.trim()).replace(Q_LABEL, '').trim();
}
function stripAnswer(s: string): string {
  return s.trim().replace(A_LABEL, '').trim();
}

/** How far below its question an answer may start and still be its answer. */
const MAX_ANSWER_GAP_LINES = 3;

/** What may come after a question on its own line: a separator, then its answer. */
const SEPARATOR_NEXT = /^\s*(?::|=>|->|>>|→|=|\||[-–—])/;

/**
 * Does a pointed question end where the student's question ends — at its "?",
 * at the end of its line, or at a separator before the answer? A comma is none
 * of those: "What is the capital of France" pointed at inside "What is the
 * capital of France, and why?" is half a question.
 */
function endsWhole(text: string, q: [number, number]): boolean {
  if (text.slice(q[0], q[1]).trimEnd().endsWith('?')) return true;
  const rest = text.slice(q[1], lineEnd(text, q[1] - 1));
  return rest.trim() === '' || SEPARATOR_NEXT.test(rest);
}

/**
 * Rebuild a pointed pair from where its halves are.
 *
 * The characters come from the page, never from the model — that is what the
 * spans are for — and the answer runs to the end of its last line, so a model
 * that pointed at half an answer does not leave the other half off the card.
 */
export function pairFromSpan(text: string, span: QaSpan): QaPair | null {
  const [q0, q1] = span.q;
  const [a0, a1] = span.a;
  if (!(q0 >= 0 && q1 > q0 && a0 >= q1 && a1 > a0 && a1 <= text.length)) return null;
  const starts = lineStarts(text);
  const question = stripQuestion(text.slice(q0, q1));
  const answer = stripAnswer(text.slice(a0, Math.max(a1, lineEnd(text, a1 - 1))));
  if (!HAS_LETTER.test(question) || answer.length === 0) return null;
  const page = readPage(text, []);
  const fromLine = lineAt(starts, q0);
  return {
    question,
    answer,
    shape: 'pointed',
    fromLine,
    toLine: lineAt(starts, a1 - 1),
    heading: headingAbove(page, fromLine),
  };
}

/**
 * Keep what Gemini pointed at, where both halves are really in the notes.
 *
 * Found by their normalised text — case, quotes and spacing may differ — and
 * mapped back to the page's own characters, so the card says what the student
 * wrote even if the model "tidied" it. A question must end with its "?" or at
 * the end of its line: a model that pointed at the first half of a question has
 * pointed at something the student did not ask. The answer must begin within a
 * few lines after its question, and nothing may overlap a pair already found.
 */
export function locatePointed(
  text: string,
  pointed: readonly { question: string; answer: string }[],
  taken: readonly QaPair[] = [],
): { pair: QaPair; span: QaSpan }[] {
  const { text: flat, map } = normalizeWithMap(text);
  const starts = lineStarts(text);
  const busy = new Set<number>();
  for (const p of taken) for (let i = p.fromLine; i <= p.toLine; i++) busy.add(i);

  const toOriginal = (at: number, length: number): [number, number] => [map[at]!, map[at + length - 1]! + 1];
  const out: { pair: QaPair; span: QaSpan }[] = [];

  for (const raw of pointed) {
    const qText = normalize(raw.question);
    const aText = normalize(raw.answer);
    if (!qText || !aText) continue;

    const qAt = flat.indexOf(qText);
    if (qAt < 0) continue;
    const q = toOriginal(qAt, qText.length);
    if (!endsWhole(text, q)) continue;

    const aAt = flat.indexOf(aText, qAt + qText.length);
    if (aAt < 0) continue;
    const a = toOriginal(aAt, aText.length);
    if (lineAt(starts, a[0]) - lineAt(starts, q[1] - 1) > MAX_ANSWER_GAP_LINES) continue;

    const span: QaSpan = { q, a };
    const pair = pairFromSpan(text, span);
    if (!pair) continue;
    let clash = false;
    for (let i = pair.fromLine; i <= pair.toLine; i++) if (busy.has(i)) clash = true;
    if (clash) continue;
    for (let i = pair.fromLine; i <= pair.toLine; i++) busy.add(i);
    out.push({ pair, span });
  }
  return out;
}

// --- a pair as a card -------------------------------------------------------------------------------

/** Each line's sentences, as [from, to) indexes into `splitSentences(text)`. */
export function lineSentences(text: string): { from: number; to: number }[] {
  let at = 0;
  return text.split(/\r?\n/).map((line) => {
    const n = splitSentences(line).length;
    const range = { from: at, to: at + n };
    at += n;
    return range;
  });
}

/**
 * The sentences a pair covers, [from, to) — the lines a card made from it
 * cites, and the lines the card-writer must leave alone.
 */
export function pairSentences(
  ranges: readonly { from: number; to: number }[],
  pair: Pick<QaPair, 'fromLine' | 'toLine'>,
): { from: number; to: number } | null {
  const lines = ranges.slice(pair.fromLine, pair.toLine + 1).filter((r) => r.to > r.from);
  if (lines.length === 0) return null;
  return { from: lines[0]!.from, to: lines[lines.length - 1]!.to };
}

const APPLY =
  /\b(?:what (?:would|will|could|might) happen|what happens (?:if|when)|suppose|imagine|if you (?:were|had|have)|calculate|compute|solve|predict|give an example|how would you|what would you|ano ang mangyayari)\b/i;
const UNDERSTAND =
  /^\W*(?:why|how(?!\s+(?:many|much|long|old|far|often|big|tall|large|few|fast|soon)\b)|explain|describe|compare|contrast|differentiate|distinguish|discuss|in what way|what(?:'s| is| are) the (?:difference|differences|relationship|similarities)|bakit|paano|ipaliwanag|ilarawan|ihambing)\b/i;

/**
 * Which level a student's own question belongs to. The levels are exclusive
 * decks (HANDOFF #7), so a set of Q:A notes all filed under "remember" would
 * leave the other two empty for no reason. "How many" is recall, not
 * understanding.
 */
export function levelFor(question: string): Level {
  if (APPLY.test(question)) return 'apply';
  if (UNDERSTAND.test(question)) return 'understand';
  return 'remember';
}

/**
 * A pair as a card, citing the student's own lines.
 *
 * The quote is taken from the page text itself — the same sentences the rest of
 * the app resolves citations against — so `excerpt_verified` means here exactly
 * what it means everywhere else: this text is in the notes.
 */
export function pairToItem(text: string, page: number, pair: QaPair): ValidatedItem | null {
  const range = pairSentences(lineSentences(text), pair);
  if (!range) return null;
  const excerpt = splitSentences(text).slice(range.from, range.to).join(' ');
  if (!excerpt) return null;
  return {
    kind: 'flashcard',
    level: pair.shape === 'term' ? 'remember' : levelFor(pair.question),
    prompt: pair.question,
    answer: pair.answer,
    page_index: page,
    source_sentence: range.from,
    ...(pair.heading ? { topic: pair.heading } : {}),
    excerpt_verified: true,
    source_excerpt: excerpt,
    source_score: 1,
  };
}

/**
 * The cards not already in the set. The same question with the same answer is
 * one card — the notes pasted twice, or a run resumed after a refresh — but the
 * same answer to two questions is two, because True/False notes have one answer
 * over and over, and that is the student's to decide.
 */
export function newCards<T extends { prompt: string; answer: string }>(
  cards: readonly T[],
  existing: readonly { prompt: string; answer: string }[],
): T[] {
  const key = (c: { prompt: string; answer: string }) => `${normalize(c.prompt)}\u0000${normalize(c.answer)}`;
  const seen = new Set(existing.map(key));
  const out: T[] = [];
  for (const card of cards) {
    const k = key(card);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(card);
  }
  return out;
}

/**
 * What a plan remembers about the pairs it keeps (NOTES §49). Stored on the
 * set's plan, which is JSON, so it needed no migration — and small on purpose:
 * `listSets` reads every plan, so the pairs the keeper can find again are found
 * again rather than stored. Only what Gemini pointed at is kept, by where it is.
 */
export interface KeptPairs {
  /** Documents whose pairs are made into cards as written. */
  documentIds: string[];
  /** Pairs Gemini pointed at, in layouts the keeper could not read. */
  pointed: { documentId: string; pageIndex: number; span: QaSpan }[];
  /** How many pairs there were when the plan was made. */
  pairs: number;
}

/** Two plans' kept pairs as one, for notes added to a set. */
export function mergeKept(a: KeptPairs | undefined, b: KeptPairs | null | undefined): KeptPairs | undefined {
  if (!b || b.pairs === 0) return a;
  if (!a) return b;
  return {
    documentIds: [...new Set([...a.documentIds, ...b.documentIds])],
    pointed: [...a.pointed, ...b.pointed],
    pairs: a.pairs + b.pairs,
  };
}

/**
 * The pairs a plan keeps on one page: what the keeper reads there, and what
 * Gemini pointed at and was found. Nothing on a page whose document is not kept.
 */
export function keptPairsOf(
  page: { document_id: string; page_index: number; text: string; headings: readonly string[] },
  keep: KeptPairs,
): QaPair[] {
  if (!keep.documentIds.includes(page.document_id)) return [];
  const found = findQaPairs(page.text, page.headings);
  const pointed = keep.pointed
    .filter((p) => p.documentId === page.document_id && p.pageIndex === page.page_index)
    .map((p) => pairFromSpan(page.text, p.span))
    .filter((p): p is QaPair => p !== null)
    .filter((p) => !found.some((f) => f.fromLine <= p.toLine && p.fromLine <= f.toLine));
  return [...found, ...pointed].sort((a, b) => a.fromLine - b.fromLine);
}

/**
 * Where a plan's kept pairs are, across a set's pages (NOTES §49): each set
 * page's pairs, and every sentence they cover — by address (`lineKey`), which
 * keeps the card-writer off them, and by text, which the fill rounds count as
 * lines that already have a card. A page too unreadable to plan from keeps
 * nothing, as it gives nothing to the planner either.
 */
export function keptOnPages(
  pages: readonly {
    document_id: string;
    page_index: number;
    set_page: number;
    text: string;
    headings: readonly string[];
    readability: number;
  }[],
  keep: KeptPairs,
  minReadability: number,
): { byPage: Map<number, QaPair[]>; lines: Set<string>; texts: Set<string> } {
  const byPage = new Map<number, QaPair[]>();
  const lines = new Set<string>();
  const texts = new Set<string>();
  for (const page of pages) {
    if (page.readability < minReadability) continue;
    const pairs = keptPairsOf(page, keep);
    if (pairs.length === 0) continue;
    byPage.set(page.set_page, pairs);
    const ranges = lineSentences(page.text);
    const sentences = splitSentences(page.text);
    for (const pair of pairs) {
      const range = pairSentences(ranges, pair);
      if (!range) continue;
      for (let s = range.from; s < range.to; s++) {
        lines.add(lineKey({ page: page.set_page, sentence: s }));
        texts.add(normalize(sentences[s] ?? ''));
      }
    }
  }
  return { byPage, lines, texts };
}

// --- what the screens say ---------------------------------------------------------------------------

const questions = (n: number) => `${n} ${n === 1 ? 'question' : 'questions'}`;

/**
 * Above the choice on Add notes. With pasted text the pairs are counted as it
 * is typed; a file or a picture is read only once the set is made, so for
 * those the choice is asked ahead of knowing.
 */
export function keepHeading(pairs: number): string {
  return pairs > 0 ? `Found ${questions(pairs)} in your notes` : 'If your notes are already questions and answers';
}

/** Under the choice: what it means. */
export function keepDetail(keep: boolean): string {
  return keep ? "They'll be kept exactly as you wrote them." : 'Nomi will write its own questions from your notes.';
}

/** What Add notes starts on when nothing is tapped and none of the student's own are kept. */
export const DEFAULT_COUNT = 20;

/**
 * The counts Add notes offers, and the one chosen.
 *
 * With questions of his own to keep, their number joins the four — the smallest
 * of which is 10, so three questions could never be made into just three cards
 * — and it is chosen until he taps another. That is what Nomi's chat picks too:
 * his questions, nothing added, and a bigger number one tap away.
 */
export function countChoices(
  base: readonly number[],
  own: number,
  picked: number | null,
): { counts: number[]; count: number } {
  const counts = own > 0 && !base.includes(own) ? [...base, own].sort((a, b) => a - b) : [...base];
  return { counts, count: picked ?? (own > 0 ? own : DEFAULT_COUNT) };
}

/** Under the count: how many cards, and whose (the owner's choice, *"my 25 + 15 from Nomi"*). */
export function countLine(count: number, pairs: number, keep: boolean): string {
  if (!keep || pairs === 0) return "We'll make this many, from all through your notes.";
  const { extra } = keptTarget(count, pairs);
  if (extra > 0) return `You'll get your ${questions(pairs)}, and Nomi adds ${extra} more.`;
  if (count === pairs || pairs === 1) return `You'll get your ${questions(pairs)}, nothing added.`;
  return `You'll get all ${pairs} of your questions.`;
}

/**
 * How many cards a set with the student's own pairs makes: all of the pairs,
 * always — nobody's own questions are dropped to fit a number — and, when the
 * count picked is bigger, Nomi writes the rest (the owner's choice, 2026-09-23:
 * *"my 25 + 15 from Nomi"*).
 */
export function keptTarget(count: number, pairs: number): { target: number; extra: number } {
  const asked = Math.max(0, Math.floor(count));
  const own = Math.max(0, Math.floor(pairs));
  return { target: Math.max(asked, own), extra: Math.max(0, asked - own) };
}
