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
    // The Sheet, the one-time privacy notice (a full page, not a panel),
    // Nomi's chat history and the folder sheet — the last two older than the
    // redesign and on the study side, next in line.
    const allowed = [
      join('src', 'ui', 'sheet.tsx'),
      join('src', 'ui', 'privacy.tsx'),
      join('app', 'nomi.tsx'),
      join('src', 'ui', 'folder-sheet.tsx'),
    ];
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
    expect(community).toContain('<TopBar title="Community" brand />');
  });

  it('the chosen tab is marked by more than colour', () => {
    const segment = read('src', 'ui', 'segment.tsx');
    const tabs = segment.slice(segment.indexOf('export function UnderlineTabs'));
    expect(tabs).toContain("fontWeight: selected ? '600' : '400'");
    expect(tabs).toContain('{selected ? (');
  });
});
