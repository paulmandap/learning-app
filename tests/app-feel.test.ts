import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserMenuAllowed, usedUserSelect } from '../src/core/app-feel';
import { messageWords } from '../src/core/posts';

/**
 * The app stops acting like a web page (NOTES §72).
 *
 * The owner, on the installed app: *"when i hold react/message, it's prompting
 * to select/select all. that's not how it works. or when i long press an image,
 * it will trigger download/copy image just like in website."*
 */

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8').replace(/\r\n/g, '\n');

describe("the browser's menu", () => {
  const plain = { tags: ['img', 'div', 'body', 'html'], editable: false, userSelect: 'none' };

  it('is kept off pictures, buttons and bubbles', () => {
    expect(browserMenuAllowed(plain)).toBe(false);
    expect(browserMenuAllowed({ ...plain, tags: ['span', 'div', 'body', 'html'] })).toBe(false);
  });

  it('stays in a field, in the note editor, and over text a screen made selectable', () => {
    expect(browserMenuAllowed({ ...plain, tags: ['input', 'div', 'body', 'html'] })).toBe(true);
    expect(browserMenuAllowed({ ...plain, tags: ['textarea', 'div', 'body', 'html'] })).toBe(true);
    expect(browserMenuAllowed({ ...plain, tags: ['p', 'div', 'body', 'html'], editable: true })).toBe(true);
    expect(browserMenuAllowed({ ...plain, tags: ['span', 'div'], userSelect: 'text' })).toBe(true);
  });

  it('takes how text selects from the nearest element that says, not from auto', () => {
    // A word inside a selectable post reports "auto"; the post says "text".
    expect(usedUserSelect(['auto', 'text', 'none'])).toBe('text');
    // A bubble's words inherit the app's "none".
    expect(usedUserSelect(['auto', 'auto', 'none'])).toBe('none');
    expect(usedUserSelect([undefined, null, ''])).toBe('text');
  });
});

describe('the page', () => {
  const html = read('public', 'index.html');

  it('nothing on the page selects or brings up the iPhone hold menu unless it says so', () => {
    // The body, not #root (§72.4): a Sheet is a Modal, which react-native-web
    // puts outside #root, so a rule on #root missed every sheet.
    expect(html).toMatch(/\n\s+body \{\n\s+-webkit-user-select: none;\n\s+user-select: none;\n\s+-webkit-touch-callout: none;\n\s+\}/);
    expect(html).not.toMatch(/#root \{\n\s+-webkit-user-select/);
  });

  it('fields and the note editor still select, or nobody could type on an iPhone', () => {
    expect(html).toMatch(
      /\n\s+input,\n\s+textarea,\n\s+\[contenteditable='true'\] \{\n\s+-webkit-user-select: text;\n\s+user-select: text;/,
    );
  });

  it('pictures cannot be dragged out', () => {
    expect(html).toMatch(/\n\s+img \{\n\s+-webkit-user-drag: none;\n\s+\}/);
  });

  it('the root layout keeps the browser menu away', () => {
    const layout = read('app', '_layout.tsx');
    expect(layout).toContain("import { keepBrowserMenusAway } from '../src/ui/app-feel';");
    expect(layout).toContain('useEffect(() => keepBrowserMenusAway(), []);');
  });
});

describe('a message', () => {
  const room = read('src', 'ui', 'chat-room.tsx');
  const actions = read('src', 'ui', 'message-actions.tsx');

  it("a bubble's words are not selectable: holding it opens its menu", () => {
    const bubble = room.slice(room.indexOf('{words ? <Text'), room.indexOf('{carried && sent.data'));
    expect(bubble).toContain('{words}');
    expect(bubble).not.toContain('selectable');
  });

  it('its menu copies the words instead', () => {
    expect(actions).toMatch(/onCopy \? \{ icon: 'notes', label: 'Copy', onPress: onCopy/);
    expect(room).toContain('void copyText(messageWords(acting.body));');
  });

  it('copies what the bubble shows: the words, never the link of a post it carries', () => {
    expect(messageWords('  see you at 3  ')).toBe('see you at 3');
    const id = '0a1b2c3d-1111-4222-8333-444455556666';
    expect(messageWords(`look at this https://learning-app-6kk.pages.dev/post/${id}`)).toBe('look at this');
    expect(messageWords(`https://learning-app-6kk.pages.dev/post/${id}`)).toBe('');
  });
});
