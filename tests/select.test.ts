import { describe, expect, it } from 'vitest';
import {
  NEW_CARD,
  reviewOrder,
  startOfUtcDay,
  studyOrder,
  type Scheduled,
} from '../src/core/schedule';

/**
 * `studyOrder` — what the study screens actually deal (Phase D).
 *
 * ## What is being pinned
 *
 * Two things, and the first matters more than the second: that this **refines**
 * the schedule rather than overruling it, and that it brings struggle forward
 * and keeps a section together within that.
 *
 * The bands — due, then never-seen, then future — are the backlog principle
 * Phase 6 established. If a refinement could reorder across them, "clear what is
 * overdue before adding new material" would quietly stop being true, and nothing
 * on screen would show it.
 *
 * ## What it is NOT allowed to do
 *
 * Change the level (the student picks that, and levels are exclusive), filter
 * anything out, or depend on section accuracy or the Phase C trend — both are
 * calibrated for a display label, not for choosing what someone studies.
 */

const NOON = Date.UTC(2026, 8, 12, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const today = startOfUtcDay(NOON);

interface Card {
  id: string;
  section: string | null;
  state: Scheduled | null;
}

/** A scheduled card. `over` sets lapses/reps; everything else is a fresh card. */
function card(
  id: string,
  section: string | null,
  dueAt: number | null,
  over: Partial<Scheduled> = {},
): Card {
  return {
    id,
    section,
    state: dueAt === null ? null : { ...NEW_CARD, dueAt, ...over },
  };
}

const order = (cards: Card[]) =>
  studyOrder(
    cards,
    (c) => c.state,
    (c) => c.section,
    NOON,
  ).map((c) => c.id);

describe('studyOrder keeps the schedule in charge', () => {
  it('still deals due, then never-seen, then not-yet-due', () => {
    // The band order is the backlog principle and is not up for renegotiation
    // by anything below. A struggling FUTURE card must not jump a calm due one.
    const cards = [
      card('future', 'A', today + 5 * DAY, { lapses: 9 }),
      card('new', 'A', null),
      card('due', 'A', today - DAY),
    ];
    expect(order(cards)).toEqual(['due', 'new', 'future']);
  });

  it('keeps every card — it orders a deck, it does not filter one', () => {
    // A deck that hid what was not due would tell someone who sat down to
    // study that there is nothing to study.
    const cards = [card('future', 'A', today + 99 * DAY), card('new', 'A', null)];
    expect(order(cards)).toHaveLength(2);
  });

  it('handles an empty deck', () => {
    expect(order([])).toEqual([]);
  });

  it('matches reviewOrder exactly when nothing has been struggled with', () => {
    // The refinement has to be invisible on a deck with no history, or Phase 6's
    // behaviour would have silently changed for every new set.
    const cards = [
      card('c', 'A', today + 2 * DAY),
      card('a', 'A', today - 7 * DAY),
      card('d', 'A', null),
      card('b', 'A', today - DAY),
    ];
    const refined = order(cards);
    const plain = reviewOrder(cards, (c) => c.state, NOON).map((c) => c.id);
    expect(refined).toEqual(plain);
  });
});

describe('studyOrder brings struggle forward', () => {
  it('deals the card that has beaten you most, first', () => {
    // Both due the same day, so only the lapse count separates them.
    const cards = [
      card('once', 'A', today, { lapses: 1 }),
      card('never', 'A', today, { lapses: 0 }),
      card('often', 'A', today, { lapses: 4 }),
    ];
    expect(order(cards)).toEqual(['often', 'once', 'never']);
  });

  it('puts a card whose last answer was wrong before one on a streak', () => {
    // reps is the scheduler's count of consecutive successes: 0 means the last
    // answer was wrong. Same lapses, so reps is the separator.
    const cards = [
      card('streak', 'A', today, { lapses: 2, reps: 3 }),
      card('justWrong', 'A', today, { lapses: 2, reps: 0 }),
    ];
    expect(order(cards)).toEqual(['justWrong', 'streak']);
  });

  it('falls back to longest-overdue when struggle is equal', () => {
    // The schedule's own answer still decides everything this has no opinion on.
    const cards = [
      card('yesterday', 'A', today - DAY, { lapses: 2 }),
      card('lastWeek', 'A', today - 7 * DAY, { lapses: 2 }),
    ];
    expect(order(cards)).toEqual(['lastWeek', 'yesterday']);
  });

  it('does not let struggle reach across bands', () => {
    // A much-failed card that is not due yet waits its turn behind a calm new
    // one. Struggle reorders within a band; it never promotes between them.
    const cards = [
      card('futureHard', 'A', today + DAY, { lapses: 9, reps: 0 }),
      card('newCalm', 'A', null),
    ];
    expect(order(cards)).toEqual(['newCalm', 'futureHard']);
  });
});

describe('studyOrder keeps a section together', () => {
  it('deals a section as a run, so a miss is followed by a sibling', () => {
    // The brief's containment rule, without any mid-session reordering: the
    // sibling is simply already the next card.
    const cards = [
      card('renal-1', 'Renal', today, { lapses: 3 }),
      card('cardiac-1', 'Cardiac', today, { lapses: 2 }),
      card('renal-2', 'Renal', today, { lapses: 0 }),
      card('cardiac-2', 'Cardiac', today, { lapses: 1 }),
    ];
    // Renal leads because its worst card (3 lapses) beats Cardiac's worst (2),
    // and both sections come out as unbroken runs.
    expect(order(cards)).toEqual(['renal-1', 'renal-2', 'cardiac-1', 'cardiac-2']);
  });

  it("orders sections by their worst card, not by their average", () => {
    // A section holding one card you keep failing is worth opening, even if
    // everything else in it is fine. An average would bury exactly that case.
    const cards = [
      card('easy-1', 'Easy', today, { lapses: 0 }),
      card('easy-2', 'Easy', today, { lapses: 0 }),
      card('hard-1', 'Hard', today, { lapses: 5 }),
      card('easy-3', 'Easy', today, { lapses: 0 }),
    ];
    expect(order(cards)[0]).toBe('hard-1');
  });

  it('groups cards with no section together rather than one each', () => {
    // They are the leftovers, not a part of the notes. Treating each as its own
    // section would scatter them through the queue as single-card runs.
    const cards = [
      card('loose-1', null, today, { lapses: 1 }),
      card('renal-1', 'Renal', today, { lapses: 2 }),
      card('loose-2', null, today, { lapses: 0 }),
    ];
    expect(order(cards)).toEqual(['renal-1', 'loose-1', 'loose-2']);
  });

  it('groups within a band, never across one', () => {
    // A section with a due card and a new card does not drag the new one
    // forward into the backlog.
    const cards = [
      card('renal-due', 'Renal', today, { lapses: 1 }),
      card('renal-new', 'Renal', null),
      card('cardiac-due', 'Cardiac', today, { lapses: 0 }),
    ];
    expect(order(cards)).toEqual(['renal-due', 'cardiac-due', 'renal-new']);
  });
});

describe('studyOrder is deterministic', () => {
  const cards = [
    card('b', 'Beta', today, { lapses: 2 }),
    card('a', 'Alpha', today, { lapses: 2 }),
    card('c', 'Beta', today, { lapses: 2 }),
  ];

  it('gives the same answer every time for the same input', () => {
    expect(order(cards)).toEqual(order(cards));
  });

  it('breaks ties on the order the cards arrived, not on the section name', () => {
    // Both sections are equally struggled with, so the deck's own order (which
    // listItems fixes as created_at ascending) decides. Sorting by name instead
    // would put "Alpha" first and make the queue depend on what a heading was
    // called.
    expect(order(cards)).toEqual(['b', 'c', 'a']);
  });
});
