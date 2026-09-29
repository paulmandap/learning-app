/**
 * Bigger hints from Gemini, measured (NOTES §69): real cards from test account
 * A's sets, a hint asked for each, and how many `givesAway` would have kept off
 * the screen — the prompt asks, the check checks.
 *
 *   npx tsx --env-file=.env scripts/hint-probe.ts [--cards 12]
 *
 * Reads cards as A (TEST_USER_A_*); calls Gemini with GEMINI_API_KEY from
 * .env, since A's stored key is a placeholder (HANDOFF). Writes nothing.
 */
import { supabase } from '../src/data/supabase';
import { GeminiBrowserProvider } from '../src/ai/gemini';
import { givesAway, quickClue } from '../src/core/hints';

async function main() {
  const email = process.env.TEST_USER_A_EMAIL;
  const password = process.env.TEST_USER_A_PASSWORD;
  const key = process.env.GEMINI_API_KEY;
  if (!email || !password || !key) throw new Error('Set TEST_USER_A_EMAIL, TEST_USER_A_PASSWORD and GEMINI_API_KEY.');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in: ${error.message}`);

  const i = process.argv.indexOf('--cards');
  const count = i === -1 ? 12 : Number(process.argv[i + 1]);
  const { data, error: readError } = await supabase
    .from('study_items')
    .select('prompt, answer, source_excerpt')
    .eq('hidden', false)
    .limit(count);
  if (readError) throw new Error(readError.message);

  const provider = new GeminiBrowserProvider(key);
  let kept = 0;
  let failed = 0;
  for (const card of (data ?? []) as { prompt: string; answer: string; source_excerpt: string }[]) {
    const started = Date.now();
    try {
      const hint = await provider.hint({
        question: card.prompt,
        answer: card.answer,
        source: card.source_excerpt,
      });
      const away = !hint || givesAway(hint, card.answer);
      if (away) kept++;
      console.log(`${away ? 'KEPT OFF' : 'SHOWN   '} ${((Date.now() - started) / 1000).toFixed(1)}s  Q: ${card.prompt.slice(0, 70)}`);
      console.log(`          A: ${card.answer.slice(0, 70)}`);
      console.log(`          clue: ${quickClue(card.answer) ?? '(none)'}`);
      console.log(`          → ${hint ?? '(nothing)'}`);
    } catch (err) {
      failed++;
      console.log(`FAILED   ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${(data ?? []).length} cards: ${kept} kept off the screen by givesAway, ${failed} failed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void supabase.auth.signOut());
