import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { invalidateStudyQueries, studyQueryKeys } from '../src/data/study-session';

/**
 * What leaving a deck refreshes.
 *
 * A real QueryClient, not a mock: the question is whether TanStack's own prefix
 * matching reaches the keys the screens actually use, and a mock would agree
 * with whatever it was told.
 */

function seeded(keys: unknown[][]): QueryClient {
  const client = new QueryClient();
  for (const key of keys) client.setQueryData(key, 'cached');
  return client;
}

const invalidated = (client: QueryClient, key: unknown[]) => client.getQueryState(key)?.isInvalidated;

describe('invalidateStudyQueries', () => {
  it('reaches every screen that shows a count a deck changes', async () => {
    const client = seeded([
      ['dashboard'],
      ['due'],
      ['due', 's1'],
      ['continue'],
      ['missed', 's1'],
      ['schedules', 's1'],
    ]);
    await invalidateStudyQueries(client, 's1');

    // Home's due counts and Continue card, the set screen's due chip, and
    // Progress — the three places the owner saw numbers that did not move.
    for (const key of [['dashboard'], ['due'], ['due', 's1'], ['continue'], ['missed', 's1'], ['schedules', 's1']]) {
      expect(invalidated(client, key), JSON.stringify(key)).toBe(true);
    }
  });

  it("leaves another set's deck alone, and anything that is not study data", async () => {
    const client = seeded([['missed', 's2'], ['schedules', 's2'], ['notes'], ['profile'], ['items', 's1']]);
    await invalidateStudyQueries(client, 's1');

    for (const key of [['missed', 's2'], ['schedules', 's2'], ['notes'], ['profile'], ['items', 's1']]) {
      expect(invalidated(client, key), JSON.stringify(key)).toBe(false);
    }
  });

  it('names the keys once, so the list and the hook cannot drift', () => {
    expect(studyQueryKeys('s1')).toContainEqual(['missed', 's1']);
    expect(studyQueryKeys('s1')).toContainEqual(['due']);
  });
});
