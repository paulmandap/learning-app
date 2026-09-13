import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { sendToNomi } from '../src/data/nomi-chat';
import { GeminiCallError } from '../src/ai/gemini';
import type { ChatReply } from '../src/ai/provider';
import { reasonToMessage } from '../src/core/ai-errors';
import { EMPTY_SNAPSHOT, type AppSnapshot } from '../src/core/nomi-brain';
import type { ChatTurn } from '../src/core/chat';
import type { Db } from '../src/data/supabase';

/**
 * How a message to Nomi is answered, driven with no network.
 *
 * The rules that matter, each pinned: the student's message is saved before
 * anything can fail; Nomi's own brain answers app questions without touching
 * the daily allowance or Gemini; the allowance is claimed before a model call;
 * and a missing history table is "not saved", never "no reply".
 */

interface Call {
  method: string;
  target: string;
  body: unknown;
}

type Reply = { rows: unknown[] } | { value: unknown } | { error: { message: string; code?: string } };

function fakeDb(replies: Record<string, Reply> = {}): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Request | string, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init?.method ?? 'GET';
    const target = url.pathname.startsWith('/auth/v1/')
      ? `auth/${url.pathname.split('/auth/v1/')[1]}`
      : (url.pathname.split('/rest/v1/')[1] ?? url.pathname);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, target, body });

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json', 'content-range': '0-0/1' },
      });

    if (target === 'auth/user') return json({ id: 'user-a' });
    const reply = replies[`${method} ${target}`] ?? replies[target];
    if (!reply) {
      // Inserts that ask for the row back get one; everything else is empty.
      if (method === 'POST' && target === 'nomi_conversations') return json({ id: 'convo-1' });
      return json([]);
    }
    if ('error' in reply) return json(reply.error, 400);
    if ('value' in reply) return json(reply.value);
    return json(reply.rows);
  }) as unknown as typeof fetch;

  const session = JSON.stringify({
    access_token: 'stub.jwt',
    refresh_token: 'stub.refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'user-a' },
  });
  const store = new Map<string, string>([['sb-stub-auth-token', session]]);
  const db = createClient('https://stub.supabase.co', 'sb_publishable_stub', {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'sb-stub-auth-token',
      storage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    },
    global: { fetch: fetchImpl },
  }) as Db;
  return { db, calls };
}

type ChatInput = { system: string; turns: ChatTurn[] };

/**
 * A provider whose reply the test chooses; records what it was sent. A string
 * is a plain answer; an object can name a topic or a title as well (NOTES §39).
 */
function provider(reply: (input: ChatInput) => Promise<string | Partial<ChatReply> | null> = async () => 'ok') {
  return {
    chat: vi.fn(async (input: ChatInput): Promise<ChatReply | null> => {
      const r = await reply(input);
      if (r === null) return null;
      const blank: ChatReply = { answer: '', reviewerTopic: null, setTitle: null };
      return typeof r === 'string' ? { ...blank, answer: r } : { ...blank, ...r };
    }),
  };
}

/** The model call, run immediately — the real queue paces and retries for tens of seconds. */
const now = <T,>(task: () => Promise<T>) => task();

const snapshot: AppSnapshot = {
  ...EMPTY_SNAPSHOT,
  name: 'Paul',
  streak: 3,
  dueToday: 7,
  sets: [{ id: 's1', title: 'Muscular System', cards: 17, due: 7, missed: 0, known: 6 }],
};

const base = {
  conversationId: null,
  history: [] as ChatTurn[],
  snapshot,
  context: { kind: 'none' as const },
  apiKey: 'AIza-test',
};

const insertsInto = (calls: Call[], table: string) =>
  calls.filter((c) => c.method === 'POST' && c.target === table);

describe('sendToNomi', () => {
  it("answers an app question from Nomi's own brain — no model, no allowance spent", async () => {
    const { db, calls } = fakeDb();
    const gemini = provider();

    const reply = await sendToNomi({ ...base, text: "what's my streak?" }, { db, provider: gemini, run: now });

    expect(reply).toMatchObject({ ok: true, source: 'brain', conversationId: 'convo-1' });
    expect(reply.ok && reply.text).toContain('3-day streak');
    expect(gemini.chat).not.toHaveBeenCalled();
    expect(calls.some((c) => c.target === 'rpc/claim_chat_message')).toBe(false);
  });

  it("saves the student's message first, then Nomi's reply, into a conversation named after it", async () => {
    const { db, calls } = fakeDb();
    await sendToNomi({ ...base, text: 'hi' }, { db, provider: provider(), run: now });

    expect(insertsInto(calls, 'nomi_conversations')[0]!.body).toMatchObject({ user_id: 'user-a', title: 'hi' });
    const messages = insertsInto(calls, 'nomi_messages').map(
      (c) => c.body as { role: string; conversation_id: string },
    );
    expect(messages.map((m) => m.role)).toEqual(['user', 'nomi']);
    expect(messages.every((m) => m.conversation_id === 'convo-1')).toBe(true);
  });

  it('continues a conversation rather than starting a new one', async () => {
    const { db, calls } = fakeDb();
    await sendToNomi({ ...base, conversationId: 'convo-9', text: 'hi' }, { db, provider: provider(), run: now });
    expect(insertsInto(calls, 'nomi_conversations')).toHaveLength(0);
    expect((insertsInto(calls, 'nomi_messages')[0]!.body as { conversation_id: string }).conversation_id).toBe(
      'convo-9',
    );
  });

  it('asks Gemini for anything else, with the thread and the facts about the student', async () => {
    const { db, calls } = fakeDb({ 'POST rpc/claim_chat_message': { value: 59 } });
    const gemini = provider(async () => 'Xylem carries water up from the roots.');
    const history: ChatTurn[] = [
      { role: 'user', text: 'hi' },
      { role: 'nomi', text: 'Hi Paul!' },
    ];

    const reply = await sendToNomi({ ...base, history, text: 'what does xylem do?' }, { db, provider: gemini, run: now });

    expect(reply).toMatchObject({
      ok: true,
      source: 'gemini',
      text: 'Xylem carries water up from the roots.',
      note: null,
    });
    const sent = gemini.chat.mock.calls[0]![0];
    expect(sent.turns).toEqual([...history, { role: 'user', text: 'what does xylem do?' }]);
    expect(sent.system).toContain('Study streak: 3 days');
    // Claimed before the call, as the old assistant did.
    expect(calls.some((c) => c.target === 'rpc/claim_chat_message')).toBe(true);
  });

  it("does not call Gemini once today's replies are used up, and still keeps the message", async () => {
    const { db, calls } = fakeDb({ 'POST rpc/claim_chat_message': { value: -1 } });
    const gemini = provider();

    const reply = await sendToNomi({ ...base, text: 'tell me a joke' }, { db, provider: gemini, run: now });

    expect(reply).toMatchObject({ ok: false, reason: 'limit_reached' });
    expect(reply.ok ? '' : reply.message).toMatch(/tomorrow/);
    expect(gemini.chat).not.toHaveBeenCalled();
    expect(insertsInto(calls, 'nomi_messages').map((c) => (c.body as { role: string }).role)).toEqual(['user']);
  });

  it('needs a key only for Gemini, and says where to add one', async () => {
    const { db } = fakeDb();
    const gemini = provider();
    const noKey = await sendToNomi({ ...base, apiKey: '', text: 'tell me a joke' }, { db, provider: gemini, run: now });
    expect(noKey).toMatchObject({ ok: false, reason: 'no_key' });
    expect(gemini.chat).not.toHaveBeenCalled();

    // …while the brain still answers without one.
    const brain = await sendToNomi({ ...base, apiKey: '', text: "what's due" }, { db, provider: gemini, run: now });
    expect(brain).toMatchObject({ ok: true, source: 'brain' });
  });

  it('still replies when chat history is not switched on, and does not pretend it saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missing = { error: { message: 'relation not in schema cache', code: 'PGRST205' } };
    const { db, calls } = fakeDb({ 'POST nomi_conversations': missing, 'POST nomi_messages': missing });

    const reply = await sendToNomi({ ...base, text: 'hi' }, { db, provider: provider(), run: now });

    expect(reply).toMatchObject({ ok: true, source: 'brain', conversationId: null });
    expect(insertsInto(calls, 'nomi_messages')).toHaveLength(0);
    warn.mockRestore();
  });

  it('sends nothing at all for a blank message', async () => {
    const { db, calls } = fakeDb();
    const reply = await sendToNomi({ ...base, text: '   ' }, { db, provider: provider(), run: now });
    expect(reply).toMatchObject({ ok: false, reason: 'empty' });
    expect(calls).toHaveLength(0);
  });

  it('says what Google refused, not "busy", when the key is bad', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = fakeDb({ 'POST rpc/claim_chat_message': { value: 40 } });
    const gemini = provider(async () => {
      throw new GeminiCallError('Gemini rejected the request.', 'invalid_key');
    });

    const reply = await sendToNomi({ ...base, text: 'explain osmosis' }, { db, provider: gemini, run: now });

    expect(reply).toMatchObject({ ok: false, reason: 'rejected', message: reasonToMessage('invalid_key') });
    warn.mockRestore();
  });

  it('says Gemini is busy rather than throwing, and keeps the conversation id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = fakeDb({ 'POST rpc/claim_chat_message': { value: 40 } });
    const gemini = provider(async () => {
      throw new Error('503');
    });

    const reply = await sendToNomi({ ...base, text: 'explain osmosis' }, { db, provider: gemini, run: now });

    expect(reply).toMatchObject({ ok: false, reason: 'busy', conversationId: 'convo-1' });
    warn.mockRestore();
  });
});

describe('sendToNomi — Nomi offers to act, and never acts on its own (NOTES §37)', () => {
  const notes = `Photosynthesis\n${Array.from(
    { length: 12 },
    (_, i) => `Plants turn light into sugar in step ${i} of the process.`,
  ).join(' ')}`;

  it('offers to make a set from pasted notes, with no model call and no allowance spent', async () => {
    const { db, calls } = fakeDb();
    const gemini = provider();

    const reply = await sendToNomi({ ...base, text: notes }, { db, provider: gemini, run: now });

    expect(reply).toMatchObject({
      ok: true,
      source: 'brain',
      proposal: { kind: 'make_set', title: 'Photosynthesis', count: 10 },
    });
    expect(gemini.chat).not.toHaveBeenCalled();
    expect(calls.some((c) => c.target === 'rpc/claim_chat_message')).toBe(false);
    // Offering is not doing: no set, document or note was created.
    for (const table of ['study_sets', 'documents', 'notes']) {
      expect(calls.some((c) => c.target.startsWith(table)), table).toBe(false);
    }
  });

  it('saves a paste as how much was pasted, not the whole page', async () => {
    const { db, calls } = fakeDb();
    const reply = await sendToNomi({ ...base, text: notes }, { db, provider: provider(), run: now });

    const saved = insertsInto(calls, 'nomi_messages').map((c) => (c.body as { content: string }).content);
    expect(saved[0]).toMatch(/^Pasted notes, \d+ words: "Photosynthesis/);
    expect(saved[0]!.length).toBeLessThan(notes.length);
    expect(reply.said).toBe(saved[0]);
  });

  it('an ordinary question carries no offer', async () => {
    const { db } = fakeDb({ 'POST rpc/claim_chat_message': { value: 50 } });
    const reply = await sendToNomi(
      { ...base, text: 'what does xylem do?' },
      { db, provider: provider(async () => 'It carries water.'), run: now },
    );
    expect(reply).toMatchObject({ ok: true, source: 'gemini', proposal: null, said: 'what does xylem do?' });
  });
});

describe('sendToNomi — a title Nomi missed, and a reviewer Nomi writes (NOTES §39)', () => {
  const offer = {
    kind: 'make_set' as const,
    title: 'nomi gawan mo nga ako reviewer,',
    notes: 'I drove up north with the windows down in late October.',
    count: 10,
    countPicked: true,
  };

  it("changes the offer on screen from the owner's follow-up, with no model call", async () => {
    const { db, calls } = fakeDb();
    const gemini = provider();
    const reply = await sendToNomi(
      { ...base, pending: offer, text: 'make the title "All Too Well by Taylor Swift"' },
      { db, provider: gemini, run: now },
    );
    expect(reply).toMatchObject({ ok: true, source: 'brain', proposal: { ...offer, title: 'All Too Well by Taylor Swift' } });
    expect(gemini.chat).not.toHaveBeenCalled();
    expect(calls.some((c) => c.target === 'rpc/claim_chat_message')).toBe(false);
  });

  it('offers to write the reviewer the owner asked for, instead of asking for notes', async () => {
    const { db } = fakeDb();
    const gemini = provider();
    const reply = await sendToNomi(
      { ...base, text: 'pwede mo ba ako gawan ng reviewer about computer parts?' },
      { db, provider: gemini, run: now },
    );
    expect(reply).toMatchObject({ ok: true, source: 'brain', proposal: { kind: 'write_reviewer', topic: 'computer parts', count: 20 } });
    expect(gemini.chat).not.toHaveBeenCalled();
  });

  it('takes a topic Gemini read from a follow-up the patterns missed, and says the offer in its own words', async () => {
    const { db } = fakeDb({ 'POST rpc/claim_chat_message': { value: 50 } });
    const history: ChatTurn[] = [
      { role: 'user', text: 'can you help me study computer parts?' },
      { role: 'nomi', text: 'Sure! Just paste your notes here.' },
    ];
    const gemini = provider(async () => ({ answer: "Okay, I'll write it!", reviewerTopic: 'computer parts' }));

    const reply = await sendToNomi({ ...base, history, text: 'ikaw na bahala sa notes pls' }, { db, provider: gemini, run: now });

    expect(reply).toMatchObject({
      ok: true,
      source: 'gemini',
      proposal: { kind: 'write_reviewer', topic: 'computer parts', title: 'Computer Parts' },
    });
    expect(reply.ok && reply.text).toMatch(/^Want me to write a reviewer on computer parts/);
    expect(gemini.chat.mock.calls[0]![0].system).toContain('reviewer_topic');
  });

  it('takes a title Gemini read for the offer on screen, and ignores one when nothing is waiting', async () => {
    const { db } = fakeDb({ 'POST rpc/claim_chat_message': { value: 50 } });
    const gemini = provider(async () => ({ answer: 'Sige!', setTitle: 'All Too Well by Taylor Swift' }));

    const renamed = await sendToNomi(
      { ...base, pending: offer, text: 'pangalanan itong All Too Well by Taylor Swift' },
      { db, provider: gemini, run: now },
    );
    expect(renamed).toMatchObject({
      ok: true,
      proposal: { ...offer, title: 'All Too Well by Taylor Swift' },
      text: `Okay, I'll call it "All Too Well by Taylor Swift".`,
    });
    expect(gemini.chat.mock.calls[0]![0].system).toContain('Waiting on their tap');

    const alone = await sendToNomi(
      { ...base, text: 'pangalanan itong All Too Well by Taylor Swift' },
      { db, provider: gemini, run: now },
    );
    expect(alone).toMatchObject({ ok: true, proposal: null, text: 'Sige!' });
  });

  it("keeps Gemini's own answer when what it named does not pass the checks", async () => {
    const { db } = fakeDb({ 'POST rpc/claim_chat_message': { value: 50 } });
    const gemini = provider(async () => ({ answer: 'Paste them here and I can help.', reviewerTopic: 'these notes' }));
    const reply = await sendToNomi({ ...base, text: 'can you help with my notes' }, { db, provider: gemini, run: now });
    expect(reply).toMatchObject({ ok: true, proposal: null, text: 'Paste them here and I can help.' });
  });
});
