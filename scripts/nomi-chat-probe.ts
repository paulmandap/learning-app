/**
 * Talk to Nomi for real: its own brain, then Gemini, then the saved history.
 *
 *   npx tsx --env-file=.env scripts/nomi-chat-probe.ts
 *
 * Replaces `assistant-probe.ts`, which drove the one-question `askAssistant`
 * that Nomi's chat replaced (NOTES §36). Signs in as TEST_USER_A, reads the
 * snapshot Nomi would see, sends a message Nomi's brain must answer without
 * a model call, then one only Gemini can answer, and prints what came back and
 * whether the conversation was saved. Deletes the conversation it made.
 *
 * Sends one real message to Gemini on the test account's key.
 */
import { supabase } from '../src/data/supabase';
import { getAppSnapshot } from '../src/data/nomi';
import { deleteConversation, listMessages, sendToNomi } from '../src/data/nomi-chat';
import { fetchProfile } from '../src/data/profile';
import type { ChatTurn } from '../src/core/chat';

async function main() {
  const email = process.env.TEST_USER_A_EMAIL;
  const password = process.env.TEST_USER_A_PASSWORD;
  if (!email || !password) throw new Error('Set TEST_USER_A_EMAIL and TEST_USER_A_PASSWORD.');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in: ${error.message}`);

  const snapshot = await getAppSnapshot();
  console.log('SNAPSHOT', JSON.stringify({ ...snapshot, sets: snapshot.sets.length }, null, 0));
  // The test account's STORED key is a placeholder — scripts/isolation-test.ts
  // writes "A-SECRET-KEY-VALUE" into it to check keys do not leak — so every
  // Gemini call on it is refused as an invalid key. The first run of this probe
  // read that as an outage (NOTES §36). GEMINI_API_KEY from .env is a real one.
  const apiKey = process.env.GEMINI_API_KEY || ((await fetchProfile())?.gemini_api_key ?? '');
  const history: ChatTurn[] = [];

  const t0 = Date.now();
  const first = await sendToNomi({ text: "what's my streak?", conversationId: null, history, snapshot, context: { kind: 'none' }, apiKey });
  console.log(`BRAIN   ${Date.now() - t0}ms`, JSON.stringify(first));
  if (first.ok) history.push({ role: 'user', text: "what's my streak?" }, { role: 'nomi', text: first.text });

  const t1 = Date.now();
  const second = await sendToNomi({
    text: 'Nice. In one sentence, what does xylem do?',
    conversationId: first.conversationId,
    history,
    snapshot,
    context: { kind: 'none' },
    apiKey,
  });
  console.log(`GEMINI  ${Date.now() - t1}ms`, JSON.stringify(second));

  const id = second.conversationId ?? first.conversationId;
  if (id) {
    const saved = await listMessages(id);
    console.log('SAVED  ', saved.map((m) => `${m.role}: ${m.content.slice(0, 60)}`));
    await deleteConversation(id);
    console.log('CLEANED UP conversation', id);
  } else {
    console.log('SAVED   nothing — chat history is not switched on (migration 0016 not applied)');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
