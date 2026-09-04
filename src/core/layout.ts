/**
 * Text alignment for card faces. Deterministic, so it is unit-tested rather
 * than hidden in a component as an inline ternary.
 *
 * The rule, from a UX review:
 *
 *   - **Centre** single words, terms, short phrases, and standalone formulas.
 *     Centring creates a focal anchor with instant visual focus.
 *   - **Left** full-sentence definitions, anything over two lines, and lists.
 *     A consistent left edge lets the eye return to the start of the next line
 *     without searching for it.
 *
 * Note on how that is implemented. The review distinguished "phrase" from
 * "full sentence", and the obvious proxy for that is terminal punctuation. This
 * uses LENGTH as the primary gate instead, because the actual reason to
 * left-align — giving the eye a fixed edge to return to — only exists once the
 * text wraps. A short question like "What is ATP?" is a full sentence by the
 * punctuation test, but it occupies one line, has no next line to return to,
 * and reads better centred. Length captures the intent; punctuation captures
 * the wording.
 *
 * Structure still wins over length: anything with a line break or a list marker
 * is left-aligned however short it is, because those genuinely have multiple
 * lines whose starts must align.
 */

/**
 * Characters that fit comfortably on one line of a card face.
 *
 * Calibrated for the narrow case, which is the one that matters: `type.card` is
 * 20px inside `space.xl` (24px) padding, so a ~390px phone leaves roughly 310px
 * of text, about 31 characters per line. Desktop fits roughly double that at
 * the 720px column, so a value tuned for the phone is conservative there — it
 * centres slightly less than it could rather than centring something that wraps.
 *
 * Tuning this one number is the whole knob: raise it to centre more.
 */
export const CENTER_MAX_CHARS = 36;

export type TextAlign = 'center' | 'left';

/** Bullets and numbering that mean "this is a list", not "this is a phrase". */
const LIST_MARKER = /(^|\n)\s*(?:[-*•‣▪]|\d+[.)])\s+\S/;

/**
 * Which alignment a piece of card text should use.
 *
 * @param text     The prompt or answer as it will be rendered.
 * @param maxChars Override the one-line budget; defaults to CENTER_MAX_CHARS.
 */
export function alignmentFor(text: string, maxChars: number = CENTER_MAX_CHARS): TextAlign {
  const trimmed = text.trim();

  // Nothing to read: centring an empty face avoids a stray left-hugging caret
  // of whitespace.
  if (trimmed.length === 0) return 'center';

  // Multiple lines by construction — the case the left edge exists for.
  if (/\r?\n/.test(trimmed)) return 'left';
  if (LIST_MARKER.test(trimmed)) return 'left';

  return trimmed.length <= maxChars ? 'center' : 'left';
}
