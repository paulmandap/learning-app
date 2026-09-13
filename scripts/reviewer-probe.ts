/**
 * Nomi writing a reviewer, and reading what its patterns miss — for real (NOTES §39).
 *
 *   npx tsx --env-file=.env scripts/reviewer-probe.ts [--runs 3] [--out reviewer.txt]
 *
 * Three questions, each answered against Google rather than assumed:
 *
 *  1. Do Nomi's own patterns catch the owner's messages? No network.
 *  2. Where they miss, does Gemini name the topic or the title — and name
 *     nothing for a question, a greeting, or chat while an offer waits? Each
 *     message is sent --runs times: one reply at temperature 0.6 is an anecdote.
 *  3. What a written reviewer is: facts, words, the cards the planner says it
 *     holds, and how long it took. --out saves the 20-card one, for
 *     `scripts/generation-probe.ts --file`.
 *
 * Uses GEMINI_API_KEY from .env — the test account's stored key is a
 * placeholder (NOTES §36). Signs in to nothing and writes nothing.
 */
import { writeFileSync } from 'node:fs';
import { GeminiBrowserProvider } from '../src/ai/gemini';
import { buildNomiSystemPrompt } from '../src/ai/prompts';
import { CallQueue } from '../src/core/queue';
import { EMPTY_SNAPSHOT, modelBrief } from '../src/core/nomi-brain';
import {
  amendProposal,
  proposeAction,
  proposeReviewer,
  retitle,
  type NomiAction,
  type Proposal,
} from '../src/core/nomi-actions';
import { checkReviewer, reviewerFacts } from '../src/core/reviewer';
import type { ChatTurn } from '../src/core/chat';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const RUNS = Number(flag('--runs') ?? 3);
const OUT = flag('--out');
/** Only the chat cases whose label holds this. */
const ONLY = flag('--only');
/** Reviewers to write, by card count: "20,60" by default, "0" for none. */
const COUNTS = (flag('--counts') ?? '20,60')
  .split(',')
  .map(Number)
  .filter((n) => n > 0);

const snapshot = { ...EMPTY_SNAPSHOT, name: 'Paul' };
const offer: NomiAction = {
  kind: 'make_set',
  title: 'nomi gawan mo nga ako reviewer,',
  notes: 'I drove up north with the windows down in late October.',
  count: 10,
  countPicked: true,
};

/** The owner's screenshot, as the thread Gemini would see it. */
const THREAD: ChatTurn[] = [
  { role: 'user', text: 'hello musta k' },
  { role: 'nomi', text: 'Hey Paul! I am doing great and ready to help you study whenever you are.' },
  { role: 'user', text: 'can you help me review computer parts?' },
  { role: 'nomi', text: 'Sure! Just paste your notes here and say make flashcards from this, and I will set them up for you.' },
];

type Outcome = 'topic' | 'title' | 'neither';

const CASES: { label: string; history: ChatTurn[]; text: string; pending: NomiAction | null; expect: Outcome }[] = [
  { label: '"you handle the notes", after asking', history: THREAD, text: 'ikaw na bahala sa notes pls', pending: null, expect: 'topic' },
  { label: 'a topic with no verb', history: [], text: 'nomi reviewer pls, computer parts', pending: null, expect: 'topic' },
  { label: 'a Taglish rename', history: [], text: 'pangalanan itong All Too Well by Taylor Swift', pending: offer, expect: 'title' },
  { label: 'a question about a topic', history: [], text: 'what are the main parts of a computer?', pending: null, expect: 'neither' },
  { label: 'a greeting', history: [], text: 'hello musta k', pending: null, expect: 'neither' },
  { label: 'chat while an offer waits', history: [], text: 'how long will the cards take?', pending: offer, expect: 'neither' },
];

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Set GEMINI_API_KEY in .env.');
  const provider = new GeminiBrowserProvider(key);
  const queue = new CallQueue();

  // 1. Patterns.
  for (const text of [
    'pwede mo ba ako gawan ng reviewer about computer parts?',
    'make the title "All Too Well by Taylor Swift"',
    'ikaw na bahala sa notes pls',
    'nomi reviewer pls, computer parts',
    'pangalanan itong All Too Well by Taylor Swift',
  ]) {
    const found = amendProposal(text, offer) ?? proposeAction(text, snapshot);
    console.log(`PATTERN ${JSON.stringify(text)}\n        → ${found?.action ? JSON.stringify(found.action) : 'missed — goes to Gemini'}`);
  }

  // 2. Gemini, where the patterns miss.
  for (const c of CASES.filter((each) => !ONLY || each.label.includes(ONLY))) {
    const system = buildNomiSystemPrompt({ brief: modelBrief(snapshot), context: { kind: 'none' }, pending: c.pending });
    let asExpected = 0;
    const lines: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const started = Date.now();
      const reply = await queue.run(() => provider.chat({ system, turns: [...c.history, { role: 'user', text: c.text }] }));
      // What sendToNomi would do with it.
      let made: Proposal | null = null;
      if (reply?.setTitle && c.pending) made = retitle(c.pending, reply.setTitle);
      if (!made && reply?.reviewerTopic) made = proposeReviewer(reply.reviewerTopic, c.text);
      const outcome: Outcome = made?.action?.kind === 'write_reviewer' ? 'topic' : made ? 'title' : 'neither';
      if (outcome === c.expect) asExpected++;
      lines.push(
        `${outcome === c.expect ? 'ok ' : 'NO '} ${outcome.padEnd(7)} topic=${JSON.stringify(reply?.reviewerTopic)} title=${JSON.stringify(reply?.setTitle)} ` +
          `says=${JSON.stringify((made?.say ?? reply?.answer ?? '').slice(0, 90))} ${Date.now() - started}ms`,
      );
    }
    console.log(`\nCHAT    ${c.label} — ${asExpected}/${RUNS} ${c.expect}`);
    for (const line of lines) console.log(`        ${line}`);
  }

  // 3. A reviewer, written.
  let saved = false;
  for (const count of COUNTS) {
    const started = Date.now();
    const raw = await queue.run(() => provider.writeReviewer({ topic: 'computer parts', facts: reviewerFacts(count) }));
    const checked = checkReviewer(raw ?? '');
    const ms = Date.now() - started;
    if (!checked.ok) {
      console.log(`\nREVIEWER ${count} cards: UNUSABLE (${checked.reason}) in ${ms}ms\n${raw}`);
      continue;
    }
    const headings = checked.notes.split('\n').filter((l) => l.startsWith('# ')).length;
    // How many facts Gemini bulleted itself, against how many the check had to.
    const bulleted = (raw ?? '').split('\n').filter((l) => /^\s*[-*•]\s/.test(l)).length;
    console.log(
      `\nREVIEWER ${count} cards: asked ${reviewerFacts(count)} facts → ${checked.facts} facts (${bulleted} bulleted by Gemini), ` +
        `${headings} headings, ${checked.notes.split(/\s+/).length} words, holds ~${checked.supports} cards, ${ms}ms`,
    );
    console.log(checked.notes.split('\n').slice(0, 8).map((l) => `        ${l}`).join('\n'));
    if (OUT && count === 20 && !saved) {
      saved = true;
      writeFileSync(OUT, checked.notes);
      console.log(`        saved ${OUT}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
