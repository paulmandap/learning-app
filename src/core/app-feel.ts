/**
 * When the browser's own menu may open over the app (NOTES §72).
 *
 * A right click on a laptop, and a hold on a picture on an Android phone, open
 * the browser's menu — "Save image as…", "Copy image", "Inspect" — which is a
 * web page's, not an app's. The owner asked for the app to stop acting like a
 * website. The menu stays where it is the right tool: in a field or the note
 * editor (paste, spelling), and over text a screen made selectable (Copy).
 *
 * Pure: `src/ui/app-feel.ts` reads the page and asks this.
 */

/** What the menu needs to know about where it was asked for. */
export interface MenuTarget {
  /** Tag names, lower case, from the element out to the page. */
  tags: readonly string[];
  /** Inside something being edited — the note editor's `contenteditable`. */
  editable: boolean;
  /** How the element's text selects — see `usedUserSelect`. */
  userSelect: string;
}

/** Whether to leave the browser's menu alone here. Everywhere else it is kept away. */
export function browserMenuAllowed(target: MenuTarget): boolean {
  if (target.editable) return true;
  if (target.tags.some((tag) => tag === 'input' || tag === 'textarea')) return true;
  return target.userSelect === 'text' || target.userSelect === 'all';
}

/**
 * How text selects at an element, from the computed `user-select` of it and
 * each element out to the page, in that order.
 *
 * `auto` means "as the element around it", so the first value that is not
 * `auto` decides. With none at all the browser's own default holds: text.
 * Computed styles report `auto` for most elements, which is why one element's
 * value alone cannot say: a word inside a selectable post is `auto` itself.
 */
export function usedUserSelect(values: readonly (string | null | undefined)[]): string {
  for (const value of values) {
    if (value && value !== 'auto') return value;
  }
  return 'text';
}
