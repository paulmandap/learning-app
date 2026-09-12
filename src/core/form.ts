/**
 * Question-type ("form") classifiers — **a Phase E1 measurement instrument.**
 *
 * NOTHING IN THE APP CALLS THIS YET, and that is deliberate. These rules exist
 * to be measured, not to be trusted. Whether any of them ships is decided by
 * the numbers in `scripts/form-probe.ts`, not by how reasonable they look here
 * — §26.1 is the standing reminder that a gate can look entirely sensible in
 * review and still cry wolf two times in five.
 *
 * ## What is being tested, and what a failure would mean
 *
 * A negative result must be attributed, never collapsed into "forms don't
 * work". Three different things can fail and they have different remedies:
 *
 *  - **the taxonomy** — the six labels do not carve real distinctions. Measured
 *    by how often a human labeller answers *ambiguous* / *multiple* / *none*.
 *    If a person cannot assign a form, no rule can, and a better rule is not
 *    the answer.
 *  - **the rule** — the distinction is real and the surface heuristic below
 *    cannot see it. That proves THIS FUNCTION inadequate and nothing else.
 *  - **the model** — it cannot produce the forms, or produces them and cannot
 *    self-report which one it wrote. Those two are also separate.
 *
 * ## Every label gets a real rule
 *
 * Including `question and answer` and `application`, which are hypothesised to
 * be a catch-all and a restatement of `level: apply` respectively. Writing a
 * strawman for either — "accepts everything" — would guarantee the hypothesis
 * confirmed and prove nothing. Each is implemented as the strongest honest
 * reading of what the label means, so the measurement can refute the guess.
 *
 * ## No rule reads `level`
 *
 * `application` must be judged on the text alone. Letting it consult
 * `level: 'apply'` would make the redundancy question circular — the instrument
 * would answer it by construction.
 *
 * ## Thresholds here are provisional
 *
 * The constants below are instrument settings chosen to be measured, not tuned
 * results. Any that survives E1 must be justified by data before it ships, the
 * way `SOURCE_SUPPORT_THRESHOLD` and Phase C's `0.40` were.
 */

import { normalize, tokenize } from './text';

/**
 * The six candidate labels, in the order §3.2.3 lists them.
 *
 * **This is the vocabulary's only home.** `prompts.ts` used to declare it too
 * and send it to the model, but that instruction had no field to answer it and
 * was removed after a controlled check (NOTES §28.9). What remains is a
 * descriptive vocabulary on no code path, kept because E1 measured it and
 * because `compare` and `cause and effect` are the two labels a future attempt
 * would start from.
 *
 * `tests/form.test.ts` pins the list literally, so changing it is a deliberate
 * act rather than a drift.
 */
export const CANDIDATE_FORMS = [
  'definition',
  'question and answer',
  'compare',
  'process',
  'cause and effect',
  'application',
] as const;

export type FormLabel = (typeof CANDIDATE_FORMS)[number];

export interface FormCandidate {
  prompt: string;
  answer: string;
}

/** Accepted, or rejected with the reason — the shape `validateMultipleChoice` uses. */
export type FormCheck = { ok: true } | { ok: false; reason: string };

const ok: FormCheck = { ok: true };
const no = (reason: string): FormCheck => ({ ok: false, reason });

/**
 * Words too structural to count as naming a thing.
 *
 * Separate from `validate.ts`'s STOPWORDS on purpose and not shared with it:
 * that list decides what counts as EVIDENCE that a sentence supports an answer,
 * this one decides what counts as NAMING a subject. They will drift apart if
 * either job changes, and merging them would couple two unrelated decisions.
 */
const STRUCTURAL = new Set([
  'the','a','an','and','or','but','of','to','in','on','at','for','with','by','from',
  'is','are','was','were','be','been','being','it','its','this','that','these','those',
  'as','which','who','whom','into','than','then','so','such','can','could','may','might',
  'will','would','shall','should','do','does','did','has','have','had','not','no','if',
  'when','while','because','they','them','their','there','also','more','most','each','one',
  'what','why','how','where','both','other','another','same','different','between',
]);

function contentWords(text: string): string[] {
  return tokenize(text).filter((w) => !STRUCTURAL.has(w) && w.length > 2);
}

// ---------------------------------------------------------------- process --

/**
 * Ordered-step markers, in three tiers.
 *
 * A process is not "contains the word then" — it is a sequence with a
 * direction. Two markers whose TIERS INCREASE along the text is the cheapest
 * deterministic reading of that: "first … finally" is ordered, "then … then"
 * is a list.
 */
const SEQUENCE_TIERS: { tier: number; source: string }[] = [
  { tier: 0, source: String.raw`\b(?:first|firstly|initially|to begin|begins? (?:with|by)|starts? (?:with|by))\b` },
  { tier: 1, source: String.raw`\b(?:then|next|secondly?|thirdly?|after (?:that|this|which)|afterwards?|subsequently|followed by|once this)\b` },
  { tier: 2, source: String.raw`\b(?:finally|lastly|eventually|at last|ends? (?:with|by)|culminates? in)\b` },
];

/** "1. … 2. …" — an explicitly numbered sequence, ordered by construction. */
const ENUMERATED_STEPS = /(?:^|\s)1[.)]\s.+\s2[.)]\s/;

/** Minimum ordered markers before a run of prose counts as a sequence. */
export const PROCESS_MIN_MARKERS = 2;

function sequenceHits(text: string): { tier: number; index: number }[] {
  const hits: { tier: number; index: number }[] = [];
  for (const { tier, source } of SEQUENCE_TIERS) {
    for (const m of text.matchAll(new RegExp(source, 'g'))) {
      if (m.index !== undefined) hits.push({ tier, index: m.index });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

export function isProcess(item: FormCandidate): FormCheck {
  const text = normalize(item.answer);

  if (ENUMERATED_STEPS.test(text)) return ok;

  const hits = sequenceHits(text);
  if (hits.length < PROCESS_MIN_MARKERS) {
    return no(`needs ${PROCESS_MIN_MARKERS} ordered step markers, found ${hits.length}`);
  }

  // Somewhere a later-tier marker must follow an earlier-tier one.
  const ordered = hits.some((a, i) => hits.slice(i + 1).some((b) => b.tier > a.tier));
  return ordered ? ok : no('step markers do not advance — a list, not a sequence');
}

// ---------------------------------------------------------------- compare --

/**
 * Connectives that set two things against each other.
 *
 * `while` is knowingly ambiguous — it is equally a temporal connective — and is
 * kept in so the measurement can show what that costs. Removing it now would be
 * tuning the instrument before reading it.
 */
const CONTRASTIVE =
  /\b(?:whereas|while|unlike|in contrast|by contrast|on the other hand|compared (?:to|with)|in comparison|versus|vs\.?|differs? from|differ from|differences? between|distinguishes?|as opposed to)\b/;

/**
 * "the difference between X and Y" — two subjects named outright.
 *
 * The comparative cue is REQUIRED and was not there in the first draft, which
 * accepted "the storage tissue lying between the epidermis and the vascular
 * cylinder" as a comparison. That is a spatial relation, and the card is a
 * definition. Caught by this file's own tests before any data was collected —
 * a bare `between … and …` is a location at least as often as a contrast.
 */
const BETWEEN_AND =
  /\b(?:difference|differences|distinction|distinguish|compare|comparison|contrast|versus|choose|choosing|decide)\b[^.?;]{0,40}\bbetween\s+(.+?)\s+and\s+(.+?)(?:[,.?;]|$)/;

export function isCompare(item: FormCandidate): FormCheck {
  const text = normalize(`${item.prompt} ${item.answer}`);

  const between = BETWEEN_AND.exec(text);
  if (between) {
    const [, left = '', right = ''] = between;
    if (contentWords(left).length > 0 && contentWords(right).length > 0) return ok;
  }

  const match = CONTRASTIVE.exec(text);
  if (!match) return no('no contrastive connective');

  const left = contentWords(text.slice(0, match.index));
  const right = contentWords(text.slice(match.index + match[0].length));
  if (left.length < 2 || right.length < 2) {
    return no('the connective does not join two described things');
  }

  // Two SUBJECTS, not one subject described twice. Parallel phrasing means the
  // two sides legitimately share most of their words ("the xylem carries water
  // upward whereas the phloem carries sugars"), so overlap is not the test —
  // each side having something of its own is.
  const leftOnly = left.filter((w) => !right.includes(w));
  const rightOnly = right.filter((w) => !left.includes(w));
  if (leftOnly.length === 0 || rightOnly.length === 0) {
    return no('both sides name the same thing');
  }

  return ok;
}

// -------------------------------------------------------- cause and effect --

/**
 * Causal connectives.
 *
 * `since` and `as` are omitted despite being genuinely causal in English: both
 * are far more often temporal or comparative in note prose, and a marker that
 * fires on "since 1998" would put the rule's non-form acceptance somewhere
 * uninterpretable.
 */
const CAUSAL =
  /\b(?:because|results? in|resulting in|results? from|leads? to|led to|causes?|caused by|causing|due to|owing to|therefore|thus|hence|consequently|as a result|so that|brings? about|triggers?|gives? rise to|enables?|prevents?)\b/;

const WHY_ASKED = /^\s*why\b|\bwhy (?:does|do|is|are|did|would|can|must)\b/;

/** Content words an answer needs before a bare "why?" counts as answered causally. */
export const CAUSE_MIN_ANSWER_WORDS = 3;

export function isCauseAndEffect(item: FormCandidate): FormCheck {
  const prompt = normalize(item.prompt);
  const answer = normalize(item.answer);

  // Prefer the answer: a causal link stated in the answer is the card being
  // ABOUT cause and effect, where one in the prompt may only be setting up.
  const source = CAUSAL.test(answer) ? answer : prompt;
  const match = CAUSAL.exec(source);
  if (match) {
    const before = contentWords(source.slice(0, match.index));
    const after = contentWords(source.slice(match.index + match[0].length));
    // A cause and an effect: something on each side of the link.
    if (before.length === 0 || after.length === 0) {
      return no('causal connective with only one side');
    }
    return ok;
  }

  // "Why does X happen?" is a causal question even when the answer states the
  // mechanism without a connective.
  if (WHY_ASKED.test(prompt)) {
    return contentWords(answer).length >= CAUSE_MIN_ANSWER_WORDS
      ? ok
      : no('asks why but the answer states no mechanism');
  }

  return no('no causal connective and does not ask why');
}

// ------------------------------------------------------------- definition --

const DEFINITION_PROMPT =
  /^\s*(?:what (?:is|are)\b|what'?s\b|define\b|what does .{1,60}\bmean\b|what is meant by\b|which term\b|what term\b|the term\b)/;

/**
 * A definition is a definitional question about ONE subject.
 *
 * The exclusions are not padding. In a taxonomy where a card carries one form,
 * "what is the difference between X and Y" is a comparison that happens to open
 * with *what is* — a human labeller assigns it to `compare` without hesitating,
 * and a rule that ignores that would inflate its own coverage by swallowing
 * three other labels. The coupling is recorded because it is exactly what makes
 * the confusion matrix partly structural rather than empirical.
 */
export function isDefinition(item: FormCandidate): FormCheck {
  const prompt = normalize(item.prompt);
  if (!DEFINITION_PROMPT.test(prompt)) return no('prompt does not ask what something is');
  if (contentWords(item.answer).length === 0) return no('answer states nothing');

  if (isCompare(item).ok) return no('asks what, but contrasts two things');
  if (isProcess(item).ok) return no('asks what, but the answer is a sequence');
  if (isCauseAndEffect(item).ok) return no('asks what, but the answer is causal');

  return ok;
}

// ------------------------------------------------------------ application --

/**
 * Scenario framing — the idea used on a case rather than restated.
 *
 * Judged on the text only. It must never consult `level`, or the question
 * "is this form redundant with `level: apply`?" answers itself.
 */
const SCENARIO =
  /\b(?:suppose|imagine|consider (?:a|an|the case)|given (?:that|a|an)|if (?:a|an|you|the)\b|what would happen|what happens if|how would you|how could you|which .{1,40}\bshould\b|in (?:a|this) (?:case|situation|scenario)|you (?:are|have|need|observe|notice|find|must)|a (?:student|patient|farmer|gardener|technician|nurse|doctor|user|company|researcher|scientist)\b)/;

/** Content words an application answer needs before it counts as applied. */
export const APPLICATION_MIN_ANSWER_WORDS = 3;

export function isApplication(item: FormCandidate): FormCheck {
  const prompt = normalize(item.prompt);
  if (!SCENARIO.test(prompt)) return no('prompt sets up no case to apply the idea to');
  return contentWords(item.answer).length >= APPLICATION_MIN_ANSWER_WORDS
    ? ok
    : no('sets up a case but the answer does not resolve it');
}

// ------------------------------------------------- question and answer ----

const DIRECT_QUESTION =
  /^\s*(?:what|which|who|whom|when|where|how many|how much|how long|name|list|state|give)\b/;

/**
 * Longest answer still readable as a short factual span.
 *
 * Provisional. The label under test here is "a direct factual question" — a
 * name, a number, a term — as distinct from the five structural forms. If E1
 * shows humans using this label for long explanatory answers too, the number is
 * wrong; if they use it for everything, the LABEL is wrong. The rule is written
 * to be able to reject, so the measurement can tell those two apart.
 */
export const QA_MAX_ANSWER_WORDS = 12;

export function isQuestionAndAnswer(item: FormCandidate): FormCheck {
  const prompt = normalize(item.prompt);
  const asks = DIRECT_QUESTION.test(prompt) || /\?\s*$/.test(prompt);
  if (!asks) return no('prompt is not a direct question');

  const words = contentWords(item.answer);
  if (words.length === 0) return no('answer states nothing');
  if (words.length > QA_MAX_ANSWER_WORDS) {
    return no(`answer runs to ${words.length} content words, not a short factual span`);
  }

  // Structural forms take precedence: this label is the direct-recall residue,
  // not a synonym for "is a card".
  if (isCompare(item).ok) return no('is a comparison');
  if (isProcess(item).ok) return no('is a sequence');
  if (isCauseAndEffect(item).ok) return no('is causal');
  if (isApplication(item).ok) return no('applies the idea to a case');

  return ok;
}

// ----------------------------------------------------------------- all ----

export const FORM_RULES: Record<FormLabel, (item: FormCandidate) => FormCheck> = {
  definition: isDefinition,
  'question and answer': isQuestionAndAnswer,
  compare: isCompare,
  process: isProcess,
  'cause and effect': isCauseAndEffect,
  application: isApplication,
};

export interface FormClassification {
  /** Every label whose rule accepts. Zero and several are both real answers. */
  accepted: FormLabel[];
  /** Why each label rejected, or null where it accepted. */
  reasons: Record<FormLabel, string | null>;
}

/**
 * Run every rule.
 *
 * Returns ALL accepting labels rather than picking a winner. Which labels
 * overlap, and how often nothing fires at all, is the measurement — collapsing
 * that to a single answer here would throw away the only evidence that can
 * separate a taxonomy failure from a rule failure.
 */
export function classifyForm(item: FormCandidate): FormClassification {
  const accepted: FormLabel[] = [];
  const reasons = {} as Record<FormLabel, string | null>;

  for (const label of CANDIDATE_FORMS) {
    const result = FORM_RULES[label](item);
    if (result.ok) {
      accepted.push(label);
      reasons[label] = null;
    } else {
      reasons[label] = result.reason;
    }
  }

  return { accepted, reasons };
}

/**
 * Fraction of items no rule claims, and the fraction several claim.
 *
 * The headline pair for E1.4: a taxonomy that leaves half its items unlabelled,
 * or hands the same card to three labels, has not partitioned anything.
 */
export function classificationSpread(items: FormCandidate[]): {
  total: number;
  unclaimed: number;
  multiple: number;
  byLabel: Record<FormLabel, number>;
} {
  const byLabel = Object.fromEntries(CANDIDATE_FORMS.map((f) => [f, 0])) as Record<
    FormLabel,
    number
  >;
  let unclaimed = 0;
  let multiple = 0;

  for (const item of items) {
    const { accepted } = classifyForm(item);
    if (accepted.length === 0) unclaimed++;
    if (accepted.length > 1) multiple++;
    for (const label of accepted) byLabel[label]++;
  }

  return { total: items.length, unclaimed, multiple, byLabel };
}
