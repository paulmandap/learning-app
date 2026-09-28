import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The rules the social redesign keeps (docs/REDESIGN_PROMPT.md, NOTES §56).
 *
 * Each is a promise about how the whole app looks that one screen could
 * quietly break — a new menu drawn as its own panel, a view switcher drawn as
 * pills again. Screenshots show that a screen looks right; these hold that
 * the next one is built the same way.
 */

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

function tsxUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.tsx')).map((f) => join(dir, f));
}

describe('everything temporary is the one sheet', () => {
  it('no screen or component draws its own panel over the page', () => {
    // The Sheet, and the one-time privacy notice (a full page, not a panel).
    // Nomi's chat history and the folder sheet were the last two, older than
    // the redesign; both are the Sheet since §60.
    const allowed = [join('src', 'ui', 'sheet.tsx'), join('src', 'ui', 'privacy.tsx')];
    for (const file of [...tsxUnder('app'), ...tsxUnder(join('src', 'ui'))]) {
      if (allowed.includes(file)) continue;
      expect(read(file), file).not.toMatch(/<Modal\b/);
    }
  });

  it('dims and blurs the page, with a grab handle, and keeps its controls out of the backdrop', () => {
    const sheet = read('src', 'ui', 'sheet.tsx');
    expect(sheet).toContain("backdropFilter: 'blur(8px)'");
    expect(sheet).toContain("WebkitBackdropFilter: 'blur(8px)'");
    expect(sheet).toMatch(/width: 36,\s*height: 5/);
    // The backdrop is a sibling that fills the window, not a button wrapped
    // around the panel — which put every control of the sheet inside "Close".
    expect(sheet).toMatch(/accessibilityLabel="Close"[\s\S]*position: 'absolute', top: 0/);
    expect(sheet).not.toContain('onPress={() => {}}');
  });

  it('the header ⋯ opens a sheet, not a corner panel', () => {
    const menu = read('src', 'ui', 'menu.tsx');
    expect(menu).toContain('<Sheet onClose={() => setOpen(false)}>');
    expect(menu).toContain('<SheetActions');
  });
});

describe('one icon style', () => {
  it('the tab bar draws its icons with Icon — the owl for Nomi', () => {
    const tabs = read('app', '(tabs)', '_layout.tsx');
    expect(tabs).toContain("label: 'Nomi', icon: 'nomi'");
    expect(tabs).toContain('<Icon name={icon} color={tint} />');
    expect(read('src', 'ui', 'glyphs.tsx')).not.toContain('export function TabIcon');
  });

  it('no control is a typed chevron, cross or arrow any more', () => {
    // The characters left in GLYPH are marks inside text.
    const glyphs = read('src', 'ui', 'glyphs.tsx');
    const table = glyphs.slice(glyphs.indexOf('export const GLYPH'), glyphs.indexOf('} as const'));
    for (const gone of ['back:', 'close:', 'send:', 'history:', 'newChat:', 'edit:', 'react:']) {
      expect(table, gone).not.toContain(gone);
    }
  });
});

describe('switching views inside a screen is an underline', () => {
  it('Community is Feed · Sets · Chat as underline tabs, under a top bar', () => {
    const community = read('app', '(tabs)', 'community.tsx');
    expect(community).toContain('<UnderlineTabs value={pane} options={PANES} onChange={setPane} />');
    expect(community).toMatch(/<TopBar\s+title="Community"\s+brand/);
    // Its action: your messages, with the tab's own unread count (NOTES §57).
    expect(community).toContain("{ icon: 'send', label: 'Messages', badge: badgeLabel(unread), onPress: () => setPane('chat') }");
  });

  it('the chosen tab is marked by more than colour', () => {
    const segment = read('src', 'ui', 'segment.tsx');
    const tabs = segment.slice(segment.indexOf('export function UnderlineTabs'));
    expect(tabs).toContain("fontWeight: selected ? '600' : '400'");
    expect(tabs).toContain('{selected ? (');
  });
});

describe('step five (NOTES §60)', () => {
  it('a sheet’s header and footer sit outside what scrolls', () => {
    const sheet = read('src', 'ui', 'sheet.tsx');
    const scroll = sheet.indexOf('<ScrollView');
    expect(sheet.indexOf('{header ?')).toBeLessThan(scroll);
    expect(sheet.indexOf('{footer ?')).toBeGreaterThan(sheet.indexOf('</ScrollView>'));
  });

  it('a new post is a tall sheet over what opened it, as in the picture', () => {
    const composer = read('app', 'post', 'new.tsx');
    expect(composer).toContain('<Sheet tall onClose={close} header={header} footer={footer}>');
    expect(composer).toContain("label={editId ? 'Save' : 'Post'}");
    for (const tool of ['"Add a photo"', '"Add a flashcard set"', '"Add your streak"', 'name="Emoji"']) {
      expect(composer, tool).toContain(tool);
    }
    // What the audience means is always on screen, not only inside the chooser.
    expect(composer).toContain('{audienceDetail(audience)}</Text>');
    // Tapping outside with words written asks before throwing them away.
    expect(composer).toContain('if (dirty && !busy) setAskDiscard(true);');
  });

  it('the long sheets keep their one button in reach', () => {
    const rules = read('src', 'ui', 'rules.tsx');
    expect(rules).toMatch(/footer=\{[\s\S]*?<Button label="I agree"/);
    const people = read('src', 'ui', 'people.tsx');
    expect(people).toMatch(/footer=\{[\s\S]*?<Button label="Send report"/);
  });

  it('every community rule has its picture', async () => {
    const { COMMUNITY_RULES } = await import('../src/core/rules');
    const rules = read('src', 'ui', 'rules.tsx');
    const table = rules.slice(rules.indexOf('export const RULE_ICONS'), rules.indexOf('};', rules.indexOf('export const RULE_ICONS')));
    for (const rule of COMMUNITY_RULES) expect(table, rule.key).toMatch(new RegExp(`\\b${rule.key}: '\\w+'`));
  });

  it('Progress is under the shared top bar; the board is rows with a flame, and finds friends through search', () => {
    expect(read('app', '(tabs)', 'progress.tsx')).not.toContain('TitleRow');
    const board = read('src', 'ui', 'leaderboard.tsx');
    expect(board).toContain('<Rows>');
    expect(board).toContain('<Icon name="streak"');
    expect(board).toContain("router.push('/search')");
  });

  it('the /icons check page is gone with the redesign done', () => {
    expect(tsxUnder('app').some((f) => f.endsWith(join('app', 'icons.tsx')))).toBe(false);
    expect(read('app', '_layout.tsx')).not.toContain('name="icons"');
  });
});
