/**
 * Display formatting for set titles.
 *
 * Set names are derived from filenames, so they arrive looking like
 * `animal_biology_study_reviewer.pdf` and get shown to the user verbatim.
 *
 * This formats at DISPLAY TIME and never rewrites what is stored: every
 * existing set improves with no migration, the original filename stays
 * recoverable, and a user who renames a set gets their exact words back
 * untouched. Deterministic, so it lives here and is unit-tested rather than
 * being an inline regex in a component.
 */

/** Extensions worth stripping. A trailing `.something` on a real title is rare. */
const FILE_EXTENSION = /\.(pdf|txt|md|png|jpe?g|webp|heic|docx?|pptx?)$/i;

/**
 * Tidy a stored title for display.
 *
 * - drops a file extension
 * - turns `_` and `-` separators into spaces
 * - collapses runs of whitespace
 * - capitalises the first letter, leaving the rest alone
 *
 * The rest is deliberately left alone. Title Case would mangle the acronyms and
 * proper nouns these titles are full of — "ATP", "DNA", "Krebs" — and lowercasing
 * would be worse still. Only the first character is touched, which is the one
 * change that is always safe.
 */
export function formatSetTitle(raw: string): string {
  const withoutExtension = raw.trim().replace(FILE_EXTENSION, '');

  const spaced = withoutExtension
    // Only separators BETWEEN characters become spaces. A leading or trailing
    // underscore is more likely deliberate than a separator.
    .replace(/(?<=\S)[_-]+(?=\S)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (spaced.length === 0) return raw.trim();

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
