/**
 * The order of "Your sets" on the Study tab.
 *
 * Pure.
 *
 * The owner: *"it would be cool in the Study tab if the ones that are due today
 * sits at the top, then after answering, it will go back to its original
 * position."* (NOTES §37.)
 *
 * So a set with cards due today moves up, and every other set keeps the place
 * it already had — a STABLE partition, not a sort. Among the due sets the
 * original order is kept too: ranking them by how many are due would make the
 * top of the list reshuffle after every answer, which is the opposite of a
 * list you can find things in. Once a set's due cards are answered its count
 * is zero and it is simply back where it was, because nothing else moved.
 */
export function dueFirst<T extends { id: string }>(sets: readonly T[], dueById: ReadonlyMap<string, number>): T[] {
  const isDue = (set: T) => (dueById.get(set.id) ?? 0) > 0;
  return [...sets.filter(isDue), ...sets.filter((set) => !isDue(set))];
}
