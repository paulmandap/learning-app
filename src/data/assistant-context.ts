import { create } from 'zustand';
import type { AssistantContext } from '../core/chat';

/**
 * What the assistant can currently see.
 *
 * The floating button is mounted once, at the root, so it survives navigation
 * and does not re-mount on every screen. But what it should KNOW depends on
 * where you are, and only the screen knows that — the flashcards screen has the
 * current card, the set screen has the notes.
 *
 * So screens push their context here as they render, and the assistant reads it.
 * A store rather than props because nothing in the tree connects a study screen
 * to a button mounted above the navigator.
 *
 * Zustand because the project already has exactly one store (`session.ts`) and
 * this is the same shape of problem — a small piece of cross-tree state that is
 * not server data and does not belong in TanStack Query.
 */
interface AssistantContextStore {
  context: AssistantContext;
  setContext: (context: AssistantContext) => void;
  /**
   * Clear back to no context.
   *
   * Screens call this on unmount, because a stale card context is worse than
   * none: the assistant would answer about a card the student left three
   * screens ago, confidently and with the wrong notes attached.
   */
  clearContext: () => void;
}

export const useAssistantContext = create<AssistantContextStore>((set) => ({
  context: { kind: 'none' },
  setContext: (context) => set({ context }),
  clearContext: () => set({ context: { kind: 'none' } }),
}));
