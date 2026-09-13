import { useCallback, useRef, useState } from 'react';
import { create } from 'zustand';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchProfile } from './profile';
import { getAppSnapshot } from './nomi';
import { listMessages, sendToNomi, type Message, type NomiReply } from './nomi-chat';
import { EMPTY_SNAPSHOT } from '../core/nomi-brain';
import type { AssistantContext, ChatTurn } from '../core/chat';

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
  set: (patch: Partial<Pick<NomiSessionStore, 'conversationId' | 'unsaved'>>) => void;
}

export const useNomiSession = create<NomiSessionStore>((set) => ({
  conversationId: null,
  unsaved: [],
  set: (patch) => set(patch),
}));

/**
 * Everything a chat window needs: the turns to show, and a way to send.
 *
 * `context` is what the screen has open — a card, a set's notes, or nothing —
 * attached to each message sent from here.
 */
export function useNomiConversation(context: AssistantContext) {
  const client = useQueryClient();
  const conversationId = useNomiSession((s) => s.conversationId);
  const unsaved = useNomiSession((s) => s.unsaved);
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

  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // A ref, set synchronously: the same double-tap that once spent two of a
  // capped allowance on one question would otherwise send a message twice.
  const inFlight = useRef(false);

  const turns: ChatTurn[] = conversationId
    ? saved.map((m) => ({ role: m.role, text: m.content }))
    : unsaved;

  const send = useCallback(
    async (text: string): Promise<NomiReply | null> => {
      if (inFlight.current || text.trim().length === 0) return null;
      inFlight.current = true;
      setPending(text.trim());
      setNote(null);
      try {
        const reply = await sendToNomi({
          text,
          conversationId,
          history: turns,
          snapshot,
          context,
          apiKey: profile?.gemini_api_key ?? '',
        });

        const said: ChatTurn = { role: 'user', text: text.trim() };
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

        setNote(reply.ok ? reply.note : reply.message);
        return reply;
      } finally {
        setPending(null);
        inFlight.current = false;
      }
    },
    [client, conversationId, turns, saved, snapshot, context, profile, setSession],
  );

  const shown: ChatTurn[] = pending ? [...turns, { role: 'user', text: pending }] : turns;

  return {
    conversationId,
    turns: shown,
    busy: pending !== null,
    loading: conversationId !== null && isLoading,
    note,
    snapshot,
    send,
    startNew: () => {
      setSession({ conversationId: null, unsaved: [] });
      setNote(null);
    },
    open: (id: string) => {
      setSession({ conversationId: id, unsaved: [] });
      setNote(null);
    },
  };
}
