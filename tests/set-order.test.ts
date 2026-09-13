import { describe, expect, it } from 'vitest';
import { dueFirst } from '../src/core/set-order';

const sets = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((s) => s.id);

describe('dueFirst — "Your sets" on the Study tab (NOTES §37)', () => {
  it('moves a set with cards due today to the top', () => {
    expect(ids(dueFirst(sets, new Map([['c', 3]])))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('puts it back where it was once nothing in it is due', () => {
    // "after answering, it will go back to its original position"
    expect(ids(dueFirst(sets, new Map([['c', 0]])))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the original order among due sets, rather than ranking them', () => {
    expect(ids(dueFirst(sets, new Map([['d', 9], ['b', 1]])))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('leaves the list it was given alone', () => {
    const before = ids(sets);
    dueFirst(sets, new Map([['d', 2]]));
    expect(ids(sets)).toEqual(before);
  });
});
