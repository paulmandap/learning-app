/**
 * What Nomi knows about the student's learning.
 *
 * Pure: a type and nothing else. No imports, no clock, no database — the same
 * rule the rest of `src/core/**` keeps, which is what lets Vitest and the
 * `scripts/*-probe.ts` harnesses load it.
 *
 * ## The distinction this type exists to hold
 *
 * Nomi is meant to be a conversational interface to a structured learning
 * system, not a chatbot that happens to sit beside one. The difference is
 * entirely in what it can see: a model given a question and nothing else can
 * only be generically encouraging, and this app already has something better —
 * every answer ever given, every schedule, and the section each card came from.
 *
 * `AssistantContext` in `./chat.ts` is a different and complementary thing. It
 * is the GROUNDING context: the card in front of you, or the set's notes, so an
 * answer comes from the student's own material rather than the model's memory.
 * This is the LEARNING context: what they have studied and how it is going.
 * One keeps Nomi truthful, the other makes it useful; neither replaces the
 * other.
 *
 * ## Deliberately almost empty
 *
 * Only `sets` is populated today, because it is the only thing available from a
 * query the app already makes. Everything Nomi will eventually want —
 *
 *   - what is due now, and how much
 *   - which sections are weak, and which are improving
 *   - recent accuracy and attempt history
 *   - the current study session
 *
 * — needs the learning intelligence of Phase C and the adaptive selection of
 * Phase D to exist first. Adding fields now would mean either speculative
 * queries or numbers with nothing behind them, and a companion that states a
 * confident figure it invented is worse than one that says nothing.
 *
 * The shape is what matters here: this is the single place those fields will be
 * added, so the screens and the orchestration above it do not have to change
 * when they are.
 */

/** One study set, as much of it as Nomi needs to talk about it. */
export interface NomiSet {
  id: string;
  title: string;
  /** How many cards it holds, when the caller knows. */
  cardCount?: number;
}

export interface NomiContext {
  /**
   * The student's study sets — the material Nomi can speak about at all.
   *
   * Empty is a real and common answer, not a failure: a new account has none,
   * and Nomi has to say so rather than imply progress that does not exist.
   */
  sets: NomiSet[];
}

/**
 * A context with nothing in it. A new account, or a read that failed.
 *
 * A function rather than an exported constant, which is not fussiness: §24.4
 * records `EMPTY_DASHBOARD` being handed out by reference on the degraded paths
 * of `fetchDashboard`, so a caller mutating what it got back would have edited
 * the shared object for every later failure in the process. Each caller here
 * gets its own.
 */
export function emptyNomiContext(): NomiContext {
  return { sets: [] };
}
