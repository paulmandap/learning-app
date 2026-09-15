import { useCallback, useRef, useState } from 'react';
import { create } from 'zustand';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchProfile } from './profile';
import { getAppSnapshot } from './nomi';
import { addNomiMessage, listMessages, sendToNomi, type Message, type NomiReply } from './nomi-chat';
import { carryOut, NeedsKeyError, type Done } from './nomi-agent';
import { ReviewerUnusableError } from './reviewer';
import { GeminiCallError } from '../ai/gemini';
import { reasonToMessage } from '../core/ai-errors';
import { GeminiBusyError } from '../core/queue';
import { EMPTY_SNAPSHOT } from '../core/nomi-brain';
import { compactForChat, type NomiAction } from '../core/nomi-actions';
import { messageToKeep, type AssistantContext, type ChatTurn } from '../core/chat';

/**
 * The conversation the student is having with Nomi, wherever they are.
 *
 * One conversation, two windows onto it: Nomi's own screen and the ✦ panel over
 * a deck. A question asked about a card continues in the full chat, and the
 * other way round — so which conversation is open lives in one small store
 * rather than in either screen, the same reason `assistant-context.ts` is a
 * store (NOTES §36).
 */

interface NomiSessionStore {
  conversationId: string | null;
  /**
   * Turns kept in memory when history cannot be saved — before migration 0016.
   * Empty whenever a saved conversation is open.
   */
  unsaved: ChatTurn[];
  /**
   * What Nomi has offered to do and is waiting on a tap for (NOTES §37).
   *
   * Here rather than on a message: saved messages are text, and the refetch
   * that replaces the optimistic rows with the real ones would otherwise take
   * the offer away with it. Both windows show the same offer.
   */
  pending: NomiAction | null;
  set: (patch: Partial<Pick<NomiSessionStore, 'conversationId' | 'unsaved' | 'pending'>>) => void;
}

export const useNomiSession = create<NomiSessionStore>((set) => ({
  conversationId: null,
  unsaved: [],
  pending: null,
  set: (patch) => set(patch),
}));

/** Why an offer could not be carried out, in words the student can act on. */
function couldNotDo(err: unknown): string {
  if (err instanceof NeedsKeyError) return 'Add your Gemini key in Settings and I can make cards for you.';
  // Say what Google refused, as the chat does: an invalid key is fixed in
  // Settings, and "try again" would send the student round in a circle (NOTES §36).
  if (err instanceof GeminiCallError) return reasonToMessage(err.reason);
  if (err instanceof GeminiBusyError) return err.message;
  if (err instanceof ReviewerUnusableError) {
    return "I couldn't write a reviewer on that. Try naming the topic a little differently.";
  }
  return "I couldn't do that just now. Try again in a moment.";
}

/**
 * Everything a chat window needs: the turns to show, a way to send, and what to
 * do about an offer.
 *
 * `context` is what the screen has open — a card, a set's notes, or nothing —
 * attached to each message sent from here.
 */
export function useNomiConversation(context: AssistantContext) {
  const client = useQueryClient();
  const conversationId = useNomiSession((s) => s.conversationId);
  const unsaved = useNomiSession((s) => s.unsaved);
  const pending = useNomiSession((s) => s.pending);
  const setSession = useNomiSession((s) => s.set);

  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const { data: snapshot = EMPTY_SNAPSHOT } = useQuery({
    queryKey: ['nomi-brain'],
    queryFn: () => getAppSnapshot(),
    staleTime: 30_000,
  });
  const { data: saved = [], isLoading } = useQuery({
    queryKey: ['nomi-messages', conversationId],
    queryFn: () => listMessages(conversationId!),
    enabled: conversationId !== null,
  });

  /** The student's message while the reply is on its way. */
  const [waiting, setWaiting] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  // A ref, set synchronously: the same double-tap that once spent two of a
  // capped allowance on one question would otherwise send a message twice —
  // or make a set twice.
  const inFlight = useRef(false);

  const turns: ChatTurn[] = conversationId
    ? saved.map((m) => ({ role: m.role, text: m.content }))
    : unsaved;

  const send = useCallback(
    async (text: string): Promise<NomiReply | null> => {
      if (inFlight.current || text.trim().length === 0) return null;
      inFlight.current = true;
      setWaiting(compactForChat(text));
      setNote(null);
      try {
        const reply = await sendToNomi({
          text,
          conversationId,
          history: turns,
          snapshot,
          context,
          apiKey: profile?.gemini_api_key ?? '',
          pending: useNomiSession.getState().pending,
        });

        // The whole message, as it was saved — what the next message sends
        // Gemini. The screen shows a paste shortened (`shown`, below).
        const said: ChatTurn = { role: 'user', text: messageToKeep(text) };
        const answered: ChatTurn[] = reply.ok ? [{ role: 'nomi', text: reply.text }] : [];

        if (reply.conversationId) {
          // Show both messages at once, then let the real rows replace them.
          // Without this the screen went blank for a round trip between the
          // pending message disappearing and the saved ones arriving.
          const id = reply.conversationId;
          const at = new Date().toISOString();
          const optimistic = [said, ...answered].map(
            (turn, i): Message => ({
              id: `local-${Date.now()}-${i}`,
              conversation_id: id,
              role: turn.role,
              content: turn.text,
              created_at: at,
            }),
          );
          client.setQueryData<Message[]>(['nomi-messages', id], (old) => [
            ...(old ?? (id === conversationId ? saved : [])),
            ...optimistic,
          ]);
          if (id !== conversationId) setSession({ conversationId: id, unsaved: [] });
          void client.invalidateQueries({ queryKey: ['nomi-messages', id] });
          void client.invalidateQueries({ queryKey: ['nomi-conversations'] });
        } else {
          setSession({ unsaved: [...turns, said, ...answered] });
        }

        // An offer lasts until it is taken or turned down, or another offer
        // replaces it. It used to end with the next message of any kind, so a
        // "make the title …" Nomi did not follow took away the offer with it,
        // and a 985-word paste had to be sent again (NOTES §39).
        if (reply.ok && reply.proposal) setSession({ pending: reply.proposal });
        setNote(reply.ok ? reply.note : reply.message);
        return reply;
      } finally {
        setWaiting(null);
        inFlight.current = false;
      }
    },
    [client, conversationId, turns, saved, snapshot, context, profile, setSession],
  );

  /** One of Nomi's lines, added to whichever conversation is open. */
  const nomiSays = useCallback(
    async (text: string) => {
      const id = useNomiSession.getState().conversationId;
      if (id) {
        client.setQueryData<Message[]>(['nomi-messages', id], (old) => [
          ...(old ?? []),
          { id: `local-${Date.now()}`, conversation_id: id, role: 'nomi', content: text, created_at: new Date().toISOString() },
        ]);
        await addNomiMessage(id, text);
        void client.invalidateQueries({ queryKey: ['nomi-messages', id] });
      } else {
        const state = useNomiSession.getState();
        state.set({ unsaved: [...state.unsaved, { role: 'nomi', text }] });
      }
    },
    [client],
  );

  /** Do what Nomi offered. The only way anything Nomi proposes gets written. */
  const confirm = useCallback(async (): Promise<Done | null> => {
    const action = useNomiSession.getState().pending;
    if (!action || inFlight.current) return null;
    inFlight.current = true;
    setActing(true);
    // A reviewer is a Gemini call before anything is saved. Say so, rather
    // than leave a spinner on a button for twenty seconds with no reason given.
    setNote(action.kind === 'write_reviewer' ? 'Writing your reviewer — this can take a little while.' : null);
    try {
      const done = await carryOut(action, { apiKey: profile?.gemini_api_key ?? '' });
      setSession({ pending: null });
      setNote(null);
      await nomiSays(done.text);
      await Promise.all(
        [['sets'], ['nomi-brain'], ['profile'], ['notes'], ['dashboard']].map((queryKey) =>
          client.invalidateQueries({ queryKey }),
        ),
      );
      return done;
    } catch (err) {
      console.warn(`[nomi] could not do that: ${err instanceof Error ? err.message : String(err)}`);
      setNote(couldNotDo(err));
      return null;
    } finally {
      setActing(false);
      inFlight.current = false;
    }
  }, [client, profile, nomiSays, setSession]);

  /** "Not now." */
  const dismiss = useCallback(() => {
    if (!useNomiSession.getState().pending) return;
    setSession({ pending: null });
    void nomiSays("Okay, I'll leave it.");
  }, [nomiSays, setSession]);

  /** Change how many cards before confirming. */
  const setCount = useCallback(
    (count: number) => {
      const action = useNomiSession.getState().pending;
      if (action && (action.kind === 'make_set' || action.kind === 'add_notes' || action.kind === 'write_reviewer')) {
        setSession({ pending: { ...action, count, countPicked: false } });
      }
    },
    [setSession],
  );

  // A conversation keeps each message whole and shows a paste as how much was
  // pasted (NOTES §45); `turns` is what goes with the next message.
  const shown: ChatTurn[] = [...turns, ...(waiting ? [{ role: 'user' as const, text: waiting }] : [])].map((turn) =>
    turn.role === 'user' ? { ...turn, text: compactForChat(turn.text) } : turn,
  );

  return {
    conversationId,
    turns: shown,
    busy: waiting !== null,
    loading: conversationId !== null && isLoading,
    note,
    snapshot,
    send,
    pending,
    acting,
    confirm,
    dismiss,
    setCount,
    startNew: () => {
      setSession({ conversationId: null, unsaved: [], pending: null });
      setNote(null);
    },
    open: (id: string) => {
      setSession({ conversationId: id, unsaved: [], pending: null });
      setNote(null);
    },
  };
}
