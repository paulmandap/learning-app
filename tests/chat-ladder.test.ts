import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_CALL_TIMEOUT_MS,
  CHAT_DEADLINE_MS,
  CHAT_SLOW_MS,
  CHAT_STICKY_MS,
  chatLadder,
  nextCallTimeout,
} from '../src/core/chat-ladder';
import { forgetLastChatModel, GeminiBrowserProvider } from '../src/ai/gemini';
import { LIGHT_LADDER } from '../src/ai/models';
import { RateLimitedError } from '../src/core/queue';

/**
 * A chat reply's own limits (NOTES §67) — the owner's "stuck in Nomi is
 * thinking…", measured as three busy models, one of them silent for a minute,
 * and a chat that gave each 100 s and then walked them all again.
 */

describe('the limits', () => {
  it('gives a model 15 s, and the whole message 45 s', () => {
    expect(CHAT_CALL_TIMEOUT_MS).toBe(15_000);
    expect(CHAT_DEADLINE_MS).toBe(45_000);
    expect(nextCallTimeout(0, 0)).toBe(15_000);
    // With 40 s gone, the next model gets the 5 s left, not 15.
    expect(nextCallTimeout(0, 40_000)).toBe(5_000);
    expect(nextCallTimeout(0, 46_000)).toBeLessThanOrEqual(0);
  });

  it('says it is still trying well before the deadline', () => {
    expect(CHAT_SLOW_MS).toBeLessThan(CHAT_CALL_TIMEOUT_MS);
  });
});

describe('which model goes first', () => {
  const ladder = ['a', 'b', 'c', 'd'];

  it('the usual order when nothing has answered yet', () => {
    expect(chatLadder(ladder, null, 1000)).toEqual(ladder);
  });

  it('the one that answered last, then the rest in order', () => {
    expect(chatLadder(ladder, { model: 'd', at: 0 }, 60_000)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('back to the usual order after ten minutes, when the first may have recovered', () => {
    expect(chatLadder(ladder, { model: 'd', at: 0 }, CHAT_STICKY_MS + 1)).toEqual(ladder);
  });

  it('ignores a model that is no longer on the ladder', () => {
    expect(chatLadder(ladder, { model: 'gone', at: 0 }, 10)).toEqual(ladder);
  });
});

describe('a chat message, through the provider', () => {
  const reply = {
    status: 200,
    body: { candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: 'Here is a hint.' }) }] } }] },
  };
  const busy = { status: 503, body: { error: { code: 503, message: 'high demand', status: 'UNAVAILABLE' } } };
  const input = { system: 'You are Nomi.', turns: [{ role: 'user' as const, text: 'a hint?' }] };

  /** Answers per model; 'hang' never answers until the call is aborted. */
  function scripted(byModel: Record<string, typeof reply | typeof busy | 'hang'>) {
    const calls: string[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const model = String(url).match(/models\/([^:]+):/)?.[1] ?? '?';
      calls.push(model);
      const next = byModel[model] ?? busy;
      if (next === 'hang') {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  beforeEach(() => {
    forgetLastChatModel();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('gives up on a silent model after 15 s and moves on — the hour it was reported', async () => {
    const [first, second, third, last] = LIGHT_LADDER;
    const { impl, calls } = scripted({ [first!]: busy, [second!]: busy, [third!]: 'hang', [last!]: reply });
    const answer = new GeminiBrowserProvider('k', { fetchImpl: impl }).chat(input);
    await vi.advanceTimersByTimeAsync(CHAT_CALL_TIMEOUT_MS + 100);
    await expect(answer).resolves.toMatchObject({ answer: 'Here is a hint.' });
    expect(calls).toEqual([...LIGHT_LADDER]);
  });

  it('asks the model that answered last first, next time', async () => {
    const last = LIGHT_LADDER.at(-1)!;
    const { impl, calls } = scripted({ [last]: reply });
    await new GeminiBrowserProvider('k', { fetchImpl: impl }).chat(input);
    calls.length = 0;
    await new GeminiBrowserProvider('k', { fetchImpl: impl }).chat(input);
    expect(calls).toEqual([last]);
  });

  it('says busy at 45 s, however many models are left', async () => {
    const { impl, calls } = scripted(Object.fromEntries(LIGHT_LADDER.map((m) => [m, 'hang'])));
    const answer = new GeminiBrowserProvider('k', { fetchImpl: impl }).chat(input);
    const settled = answer.catch((err) => err);
    await vi.advanceTimersByTimeAsync(CHAT_DEADLINE_MS + 1000);
    expect(await settled).toBeInstanceOf(RateLimitedError);
    // Three models at 15 s is the 45; the fourth is never started.
    expect(calls).toEqual(LIGHT_LADDER.slice(0, 3));
  });
});

describe('in the app', () => {
  it('the chat does not walk the ladder again after 10 s and 20 s', () => {
    expect(readFileSync('src/data/nomi-chat.ts', 'utf8')).toContain('const queue = new CallQueue({ maxAttempts: 1 });');
  });

  it('card-making keeps its own, longer deadline', () => {
    const gemini = readFileSync('src/ai/gemini.ts', 'utf8');
    expect(gemini).toContain('const CALL_TIMEOUT_MS = 100_000;');
    expect(gemini).toContain('const timeout = chat ? nextCallTimeout(chat.startedAt, Date.now()) : CALL_TIMEOUT_MS;');
  });

  it('both chat windows say "still trying" when it is slow', () => {
    expect(readFileSync('src/ui/assistant.tsx', 'utf8')).toContain('Still thinking — Gemini is slow right now.');
    expect(readFileSync('app/nomi.tsx', 'utf8')).toContain('<ThinkingBubble slow={chat.slow} />');
  });
});
