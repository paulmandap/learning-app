/**
 * Does the study assistant actually answer from the student's own notes?
 *
 * Drives the real `askAssistant` path — the daily-cap claim, the prompt, the
 * model call through LIGHT_LADDER and CallQueue — against live Gemini and the
 * live database. `src/data/**` imports nothing from react-native, which is what
 * makes this reachable from Node at all.
 *
 * The check that matters is not "did it reply" but **"did it reply from the
 * notes"**. So it asks about a real card and looks for the answer that card's
 * own source sentence supports. A fluent reply that ignores the notes is the
 * failure this feature exists to avoid, and it looks like success.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/assistant-probe.ts [--set <id>]
 *
 * Needs TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD and GEMINI_API_KEY (or GK).
 */
import { supabase } from '../src/data/supabase';
import { askAssistant } from '../src/data/assistant';
import { pagesForSet } from '../src/data/documents';
import { promptFor } from '../src/data/items';
import { trimNotes, DAILY_MESSAGE_LIMIT } from '../src/core/chat';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GK ?? '';
  if (!apiKey) throw new Error('set GEMINI_API_KEY');

  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_A_EMAIL!,
    password: process.env.TEST_USER_A_PASSWORD!,
  });
  if (authErr) throw new Error(`sign-in: ${authErr.message}`);

  let query = supabase
    .from('study_items')
    .select('id, kind, prompt, variant_prompt, answer, source_excerpt, study_set_id')
    .eq('hidden', false)
    .eq('kind', 'flashcard');
  const setId = arg('--set');
  if (setId) query = query.eq('study_set_id', setId);

  const { data, error } = await query.limit(1);
  if (error) throw new Error(error.message);
  const card = data?.[0];
  if (!card) throw new Error('no flashcards in this account to ask about');

  console.log(`${'='.repeat(78)}\nASSISTANT PROBE\n${'='.repeat(78)}`);
  console.log(`\ndaily cap: ${DAILY_MESSAGE_LIMIT} questions`);

  // --------------------------------------------------------- card context --
  console.log(`\n--- card context ---`);
  console.log(`  card:   ${promptFor(card)}`);
  console.log(`  answer: ${card.answer}`);
  console.log(`  source: ${card.source_excerpt.slice(0, 100)}`);

  const onCard = await askAssistant({
    question: 'Why is that the answer? Explain it simply.',
    context: {
      kind: 'card',
      prompt: promptFor(card),
      answer: card.answer,
      source: card.source_excerpt,
    },
    apiKey,
  });

  if (onCard.ok) {
    console.log(`\n  reply (${onCard.answer.length} chars, ${onCard.remaining} left today):`);
    console.log(`    ${onCard.answer.replace(/\n/g, '\n    ')}`);
    // Grounding, checked rather than assumed: a fluent reply that ignores the
    // notes is exactly the failure that looks like success.
    const words = card.answer
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w: string) => w.length > 3);
    const grounded = words.some((w: string) => onCard.answer.toLowerCase().includes(w));
    console.log(`\n  => mentions the card's own answer: ${grounded ? 'YES' : 'NO'}`);
    console.log(`  => within four sentences: ${(onCard.answer.match(/[.!?]/g) ?? []).length <= 5}`);
  } else {
    console.log(`\n  !! ${onCard.reason}: ${onCard.message}`);
  }

  // ---------------------------------------------------------- set context --
  const pages = await pagesForSet(card.study_set_id);
  const notes = trimNotes(pages.map((p) => p.text).join('\n\n'));
  console.log(`\n--- set context (${notes.length} chars of notes) ---`);

  const onSet = await askAssistant({
    question: 'What are the main things these notes cover?',
    context: { kind: 'set', title: 'Test set', notes },
    apiKey,
  });

  if (onSet.ok) {
    console.log(`\n  reply (${onSet.answer.length} chars, ${onSet.remaining} left today):`);
    console.log(`    ${onSet.answer.replace(/\n/g, '\n    ')}`);
  } else {
    console.log(`\n  !! ${onSet.reason}: ${onSet.message}`);
  }

  // ------------------------------------------------------- refusal paths --
  console.log(`\n--- refusals (no model call should happen) ---`);
  const empty = await askAssistant({ question: '  ', context: { kind: 'none' }, apiKey });
  console.log(`  empty question:  ${empty.ok ? 'ACCEPTED (wrong)' : empty.reason}`);
  const noKey = await askAssistant({ question: 'Hello?', context: { kind: 'none' }, apiKey: '' });
  console.log(`  no key:          ${noKey.ok ? 'ACCEPTED (wrong)' : noKey.reason}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
