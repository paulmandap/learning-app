/**
 * LLM verification of Apply-tier rubrics (D7's postponed second pass).
 *
 * Pure and deterministic. A model reads a marking checklist against the source
 * it came from and NAMES the points it cannot support; the verdict is computed
 * here. That is the same division of labour as grading (§3.3, src/core/grade.ts)
 * and for the same reason — a model asked for a verdict will happily give one,
 * and nothing checks it.
 *
 * ## Why only Apply-tier written answers
 *
 * D7 says so, and the reason holds up. A rubric only exists on `short_answer`
 * items, and only those are graded against one. Remember and Understand items
 * are mostly recall with a single right answer, where the deterministic
 * validators already do the work. Apply items ask a student to use an idea on a
 * new case, which is where a checklist can quietly include a point the notes
 * never made — and where being marked down for not saying it is least fair.
 *
 * It is also the only tier small enough to afford: a second call per item is
 * real quota, and Apply is 20% of a set (§3.2.2).
 *
 * ## What a failure means, and what it does not
 *
 * `rubric_verified = false` is a SOFT failure. The card is kept and still
 * studied; the quiz shows a quiet caution next to the marking. It says one
 * checklist point could not be traced to the cited source — not that the
 * question is wrong, and emphatically not anything about `excerpt_verified`,
 * whose meaning §4 fixes exactly and which this must never be confused with.
 */

export interface RubricConcept {
  id: string;
  text: string;
}

/** What the model returns: which points it could not support, and why. */
export interface RubricCheckReply {
  unsupported: string[];
  note: string;
}

export interface RubricVerdict {
  verified: boolean;
  /** Ids the model flagged, filtered to ones that actually exist. */
  unsupported: string[];
  /** One short sentence, or '' — shown to the user, so it is trimmed here. */
  note: string;
}

/**
 * Is this item one the second pass should look at?
 *
 * `rubricVerified === null` is "not yet checked". A card already checked is
 * never re-checked: the answer would not change, and paying for it again on
 * every visit to a set would be a quota leak that grows with use.
 */
export function shouldVerifyRubric(item: {
  kind: string;
  level: string;
  rubric: { expected_concepts: RubricConcept[] } | null;
  rubricVerified: boolean | null;
}): boolean {
  return (
    item.rubricVerified === null &&
    item.kind === 'short_answer' &&
    item.level === 'apply' &&
    (item.rubric?.expected_concepts.length ?? 0) > 0
  );
}

/**
 * Turn the model's reply into a verdict.
 *
 * Defensive in the same way `gradeWritten` is: ids the model invented are
 * discarded rather than counted. A model that echoed plausible-looking ids would
 * otherwise fail every rubric it was shown.
 *
 * The note is capped at one sentence because it goes on screen next to a
 * question, where a paragraph of hedging would be worse than nothing.
 */
export function rubricVerdict(
  expected: RubricConcept[],
  reply: RubricCheckReply,
): RubricVerdict {
  const validIds = new Set(expected.map((c) => c.id));
  const unsupported = [...new Set(reply.unsupported)].filter((id) => validIds.has(id));

  // Every point unsupported is not a careful critique, it is a model that has
  // misread the task — treat it as inconclusive rather than condemning the card.
  const allFlagged = expected.length > 0 && unsupported.length === expected.length;

  return {
    verified: unsupported.length === 0 || allFlagged,
    unsupported: allFlagged ? [] : unsupported,
    note: allFlagged ? '' : firstSentence(reply.note),
  };
}

function firstSentence(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length === 0) return '';
  const match = clean.match(/^[^.!?]*[.!?]?/);
  return (match?.[0] ?? clean).trim();
}
