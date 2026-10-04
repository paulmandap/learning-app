import { Platform } from 'react-native';
import { browserMenuAllowed, usedUserSelect } from '../core/app-feel';

/**
 * Keep the browser's own menu off the app (NOTES §72) — a right click on a
 * laptop, and a hold on a picture on an Android phone, which both arrive as
 * `contextmenu`. On an iPhone a hold sends no `contextmenu`; the CSS in
 * `public/index.html` (`-webkit-touch-callout: none`) is what stops its menu.
 *
 * Where the menu is still the right tool is decided in `src/core/app-feel.ts`.
 * Returns the function that stops listening.
 */
export function keepBrowserMenusAway(): () => void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return () => undefined;

  const onMenu = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const tags: string[] = [];
    const selects: (string | undefined)[] = [];
    for (let node: Element | null = target; node; node = node.parentElement) {
      tags.push(node.tagName.toLowerCase());
      const style = getComputedStyle(node) as CSSStyleDeclaration & { webkitUserSelect?: string };
      selects.push(style.userSelect || style.webkitUserSelect);
    }
    const editable = target instanceof HTMLElement && target.isContentEditable;
    if (browserMenuAllowed({ tags, editable, userSelect: usedUserSelect(selects) })) return;
    event.preventDefault();
  };

  document.addEventListener('contextmenu', onMenu);
  return () => document.removeEventListener('contextmenu', onMenu);
}
