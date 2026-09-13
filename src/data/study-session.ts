import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { recordAttempt } from './attempts';

/**
 * Answers recorded during a deck, and the screens told about them afterwards.
 *
 * ## The defect
 *
 * Nothing in the app invalidated a single query after an answer. Home's due
 * counts and Continue card, and Progress's "Retry what you missed", are read
 * once and cached; the tab screens stay mounted under a deck, and the client
 * never refetches on focus. So finishing a deck and pressing back returned to
 * the numbers from before it — "8 due today" with the eight just answered
 * (NOTES §36).
 *
 * ## Why once, on leaving, and not after every answer
 *
 * - **The deck must not change under the student.** The retry deck is built
 *   from the missed pile; refetching that pile after each correct answer would
 *   remove the card just answered from the list the cursor is walking, and the
 *   next card would be skipped.
 * - **Nothing else is on screen.** Home and Progress are behind the deck. A
 *   dashboard refetch per answer is six queries per card for screens nobody can
 *   see.
 *
 * So the screen records through this hook, and when the deck unmounts it waits
 * for every answer still being written — `recordAttempt` is fire-and-forget,
 * and a refetch that beats the last write would bring the stale number straight
 * back — and then invalidates, once.
 */

/** Every cached query whose answer changes when a card in `setId` is answered. */
export function studyQueryKeys(setId: string): readonly (readonly string[])[] {
  return [
    ['dashboard'],
    // Prefix match: Home's ['due'] and the set screen's ['due', setId] both.
    ['due'],
    ['continue'],
    ['missed', setId],
    ['schedules', setId],
    ['nomi-brain'],
  ];
}

export async function invalidateStudyQueries(client: QueryClient, setId: string): Promise<void> {
  await Promise.all(
    studyQueryKeys(setId).map((queryKey) => client.invalidateQueries({ queryKey: [...queryKey] })),
  );
}

type AttemptInput = Parameters<typeof recordAttempt>[0];

/**
 * Record answers for one deck; refresh the rest of the app when the deck closes.
 *
 * Returns the recorder. Its promise still rejects on failure, so a caller that
 * catches today keeps catching.
 */
export function useStudySession(setId: string): (input: AttemptInput) => Promise<void> {
  const client = useQueryClient();
  const pending = useRef(new Set<Promise<void>>());

  useEffect(() => {
    const inFlight = pending.current;
    return () => {
      void Promise.allSettled([...inFlight]).then(() => invalidateStudyQueries(client, setId));
    };
  }, [client, setId]);

  return useCallback((input: AttemptInput) => {
    const attempt = recordAttempt(input);
    pending.current.add(attempt);
    const settle = () => {
      pending.current.delete(attempt);
    };
    attempt.then(settle, settle);
    return attempt;
  }, []);
}
