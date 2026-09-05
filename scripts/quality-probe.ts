/**
 * Does the Phase 8 quality pass actually work on real cards?
 *
 * Two model calls that nothing else in the app exercises:
 *
 *   1. REPHRASE — rewrite a question the student keeps missing (§3.3), then run
 *      the deterministic checks in src/core/variant.ts over the result.
 *   2. RUBRIC   — D7's postponed second pass over an Apply-tier marking
 *      checklist, then compute the verdict in src/core/rubric.ts.
 *
 * READ-ONLY against the database on purpose: it stores nothing, so it runs
 * against a project that has not had 0007 applied yet, and it can be pointed at
 * real cards without editing them.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/quality-probe.ts [--set <id>] [--limit 3]
 *
 * Needs TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD and GEMINI_API_KEY (or GK).
 */
import { supabase } from '../src/data/supabase';
import { pagesForSet } from '../src/data/documents';
import { GeminiBrowserProvider } from '../src/ai/gemini';
import { CallQueue } from '../src/core/queue';
import { validateVariant } from '../src/core/variant';
import { rubricVerdict, shouldVerifyRubric } from '../src/core/rubric';

interface Row {
  id: string;
  kind: string;
  level: string;
  prompt: string;
  answer: string;
  source_excerpt: string;
  page_index: number | null;
  study_set_id: string;
  rubric: { expected_concepts: { id: string; text: string }[]; model_answer: string } | null;
}

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

  const limit = Number(arg('--limit') ?? 3);
  const setId = arg('--set');

  let query = supabase
    .from('study_items')
    .select('id, kind, level, prompt, answer, source_excerpt, rubric, page_index, study_set_id')
    .eq('hidden', false);
  if (setId) query = query.eq('study_set_id', setId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as Row[];

  const provider = new GeminiBrowserProvider(apiKey);
  const queue = new CallQueue();

  // ------------------------------------------------------------ rephrase --
  const cards = rows.filter((r) => r.kind === 'flashcard').slice(0, limit);
  console.log(`\n${'='.repeat(78)}\nREPHRASE — ${cards.length} card(s)\n${'='.repeat(78)}`);

  for (const card of cards) {
    console.log(`\n  was: ${card.prompt}`);
    console.log(`  answer: ${card.answer}`);
    try {
      const reply = await queue.run(() =>
        provider.rephrasePrompt({
          prompt: card.prompt,
          answer: card.answer,
          sourceExcerpt: card.source_excerpt,
        }),
      );
      if (!reply) {
        console.log('  !! model returned nothing usable');
        continue;
      }
      console.log(`  now: ${reply.prompt}`);

      const checked = validateVariant({
        original: card.prompt,
        rephrased: reply.prompt,
        answer: card.answer,
        sourceExcerpt: card.source_excerpt,
      });
      console.log(checked.ok ? '  => ACCEPTED' : `  => REJECTED (${checked.reason})`);
    } catch (err) {
      console.log(`  !! ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -------------------------------------------------------------- rubric --
  const applyItems = rows
    .filter((r) =>
      shouldVerifyRubric({ kind: r.kind, level: r.level, rubric: r.rubric, rubricVerified: null }),
    )
    .slice(0, limit);

  console.log(
    `\n${'='.repeat(78)}\nRUBRIC CHECK — ${applyItems.length} Apply-tier item(s)\n${'='.repeat(78)}`,
  );
  if (applyItems.length === 0) {
    console.log('  none in this account. Generate a set with Apply items first.');
  }

  for (const item of applyItems) {
    const rubric = item.rubric!;
    console.log(`\n  Q: ${item.prompt}`);
    console.log(`  source: ${item.source_excerpt.slice(0, 120)}`);
    for (const c of rubric.expected_concepts) console.log(`    - ${c.id}: ${c.text}`);
    try {
      const pages = await pagesForSet(item.study_set_id);
      const page = pages.find((p) => p.page_index === (item.page_index ?? 0));
      const reply = await queue.run(() =>
        provider.verifyRubric({
          prompt: item.prompt,
          rubric,
          sourceExcerpt: item.source_excerpt,
          sourceText: page?.text ?? item.source_excerpt,
        }),
      );
      if (!reply) {
        console.log('  !! model returned nothing usable — rubric_verified stays null');
        continue;
      }
      const verdict = rubricVerdict(rubric.expected_concepts, reply);
      console.log(
        `  => rubric_verified = ${verdict.verified}` +
          `${verdict.unsupported.length ? ` (unsupported: ${verdict.unsupported.join(', ')})` : ''}` +
          `${verdict.note ? ` — "${verdict.note}"` : ''}`,
      );
    } catch (err) {
      console.log(`  !! ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\nNothing was written to the database.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
