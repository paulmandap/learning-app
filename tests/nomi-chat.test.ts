import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { sendToNomi } from '../src/data/nomi-chat';
import { GeminiCallError } from '../src/ai/gemini';
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

/** A provider whose reply the test chooses; records what it was sent. */
function provider(reply: (input: ChatInput) => Promise<string | null> = async () => 'ok') {
  return { chat: vi.fn(reply) };
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
