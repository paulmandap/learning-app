import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No field may use text under 16px.
 *
 * iOS Safari force-zooms the page when a field with smaller text takes focus,
 * and it does not zoom back out. The owner found it on an iPhone: tapping the
 * assistant zoomed the app, and swiping around the zoomed page revealed blank
 * canvas past its edges. Two fields were 15px.
 *
 * ## Why this test reads source text instead of rendering anything
 *
 * There is no honest alternative here. `src/ui/**` imports react-native, which
 * this suite cannot load, and the screenshot harness drives headless Chrome on
 * Windows, which has no such zoom rule — so the defect is invisible to both of
 * the checks that catch everything else in this project. It is visible on an
 * iPhone and in the source, and only one of those runs in CI.
 *
 * Crude, therefore, and deliberately so: it looks at the numbers written inside
 * a TextInput's style and at the constant the rest point to. A style computed
 * at runtime would slip past it. That is the trade for having any check at all.
 */

const ROOTS = ['src', 'app'];
const MINIMUM = 16;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (extname(full) === '.tsx') out.push(full);
  }
  return out;
}

/** Every `<TextInput …>` opening tag in a file, as raw text. */
function textInputTags(source: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('<TextInput', from);
    if (start === -1) return tags;
    // The tag ends at its first `/>` — every TextInput in this codebase is
    // self-closing, and a nested `>` inside a style object cannot appear before
    // one because the style is an object literal, not markup.
    const end = source.indexOf('/>', start);
    tags.push(source.slice(start, end === -1 ? source.length : end));
    from = end === -1 ? source.length : end;
  }
}

describe('iOS will not zoom the page when a field is tapped', () => {
  it('has no TextInput with text under 16px', () => {
    const offenders: string[] = [];

    for (const root of ROOTS) {
      for (const file of tsxFiles(root)) {
        const source = readFileSync(file, 'utf8');
        for (const tag of textInputTags(source)) {
          for (const [, size] of tag.matchAll(/fontSize:\s*(\d+)/g)) {
            if (Number(size) < MINIMUM) offenders.push(`${file}: fontSize ${size}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the shared minimum at 16 or above', () => {
    // The field most inputs point at instead of writing a number. Lowering it
    // would zoom every screen at once, and the tags above would still pass.
    const theme = readFileSync(join('src', 'ui', 'theme.ts'), 'utf8');
    const declared = theme.match(/export const INPUT_FONT_SIZE = (\d+)/);
    expect(declared, 'INPUT_FONT_SIZE is gone — inputs have nothing to point at').not.toBeNull();
    expect(Number(declared![1])).toBeGreaterThanOrEqual(MINIMUM);
  });
});
