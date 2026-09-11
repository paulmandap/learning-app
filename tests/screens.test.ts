import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guards for four defects that lived in screen code.
 *
 * ## Why this reads source text rather than rendering anything
 *
 * Same reason as `tests/input-zoom.test.ts`, and the same trade. Every file
 * under `app/**` imports react-native, which this suite cannot load — that is
 * the deliberate boundary that keeps `src/core/**` testable, and it is also why
 * 447 tests covered none of the code these four bugs were in. The one that
 * mattered most, a dashboard button whose every branch navigated to the wrong
 * place, shipped and stayed shipped precisely because nothing could reach it.
 *
 * So: crude checks, deliberately so, asserting intent rather than formatting.
 * They cannot prove a screen behaves correctly. They can prove that the
 * specific thing that was wrong has not been quietly written back, which is
 * what a regression guard is for. Anything genuinely computable was moved into
 * `src/core/progress.ts` instead and is properly tested there — see
 * `busiestSet` in `tests/progress.test.ts`.
 */

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

/**
 * The body of a `LEVELS.map(...)` render block.
 *
 * Anchored on the call rather than on a line number, and generous enough to
 * cover the whole `<Button>` inside it without reaching the next block.
 */
function levelSegment(source: string): string {
  const start = source.indexOf('LEVELS.map(');
  expect(start, 'the level segment is gone').toBeGreaterThan(-1);
  return source.slice(start, start + 600);
}

describe('the dashboard button goes where it says', () => {
  const progress = read('app', '(tabs)', 'progress.tsx');

  /** `NextStep`'s own source, so the assertions cannot be satisfied elsewhere. */
  function nextStep(): string {
    const start = progress.indexOf('function NextStep');
    expect(start, 'NextStep is gone').toBeGreaterThan(-1);
    const end = progress.indexOf('\nfunction ', start + 1);
    return progress.slice(start, end === -1 ? progress.length : end);
  }

  it('sends the missed pile to the retry deck, not to the set list', () => {
    // The bug: `Retry what you missed (12)` called router.push('/').
    expect(nextStep()).toContain('flashcards?retry=1');
  });

  it('uses the same retry route Home already uses', () => {
    // One retry destination in the app, not two that can drift apart.
    const home = read('app', '(tabs)', 'index.tsx');
    expect(home).toContain('flashcards?retry=1');
  });

  it('keeps exactly one branch pointing at the set list', () => {
    // "Go to your sets" is correct and stays. The other two were not.
    const toRoot = nextStep().match(/router\.push\('\/'\)/g) ?? [];
    expect(toRoot).toHaveLength(1);
  });

  it('will not build a route out of a missing set id', () => {
    // busiestSet returns null when there is nowhere to send anyone, and
    // `/set/null/flashcards` is a broken screen where the list is a plain one.
    const body = nextStep();
    expect(body).toMatch(/data\.retryTarget/);
    expect(body).toMatch(/data\.dueTarget/);
  });

  it('offers those targets from the dashboard query', () => {
    const dashboard = read('src', 'data', 'dashboard.ts');
    expect(dashboard).toContain('retryTarget');
    expect(dashboard).toContain('dueTarget');
    // The set id rides along on the two queries that were being made anyway.
    // A separate round trip just to find out where a button should point would
    // be the wrong trade on a screen whose every query degrades to empty.
    const selects = dashboard.match(/\.select\('study_item_id, study_set_id/g) ?? [];
    expect(selects, 'the set id is no longer coming from the existing queries').toHaveLength(2);
  });
});

describe('every level segment says how many cards it will deal', () => {
  // A button promising 10 that then deals 3 is a lie — the rule was written in
  // quiz.tsx's own countByLevel docstring and then not applied to its buttons.
  const screens = ['flashcards.tsx', 'quiz.tsx', 'blanks.tsx'];

  for (const screen of screens) {
    it(`${screen} shows the count on the level buttons`, () => {
      const source = read('app', 'set', '[id]', screen);
      expect(levelSegment(source)).toContain('countByLevel');
    });
  }

  it('quiz no longer renders a bare label', () => {
    const source = read('app', 'set', '[id]', 'quiz.tsx');
    expect(levelSegment(source)).not.toMatch(/label=\{l\.label\}/);
  });
});

describe('all three study modes share one retry pile', () => {
  const modes = ['flashcards.tsx', 'quiz.tsx', 'blanks.tsx'];

  for (const mode of modes) {
    it(`${mode} reads ?retry=1`, () => {
      const source = read('app', 'set', '[id]', mode);
      expect(source).toMatch(/retry\?:\s*string/);
      expect(source).toContain("retry === '1'");
    });

    it(`${mode} takes the pile from missedItemIds under the shared query key`, () => {
      // Not a second definition of "missed". One pile, three ways of being
      // asked about it — the query key is shared so switching mode is a cache
      // read rather than another round trip.
      const source = read('app', 'set', '[id]', mode);
      expect(source).toContain('missedItemIds');
      expect(source).toContain("['missed', setId]");
    });
  }
});

describe('the set screen does not decide what to render from a ref', () => {
  const source = read('app', 'set', '[id]', 'index.tsx');

  /** Everything from the component's own `return (` onward. */
  function renderBody(): string {
    const start = source.lastIndexOf('\n  return (');
    expect(start, "the set screen's return is gone").toBeGreaterThan(-1);
    return source.slice(start);
  }

  it('never reads started.current while rendering', () => {
    // Mutating a ref schedules no re-render, so "Keep going" appeared or did
    // not depending on whether unrelated state happened to change afterwards.
    expect(renderBody()).not.toContain('started.current');
  });

  it('still guards the generation run with the ref', () => {
    // The ref is not redundant: it is set synchronously, so an effect that runs
    // twice before a commit still starts one generateSet. State cannot do that.
    expect(source).toContain('started.current = true');
    expect(source).toContain('if (started.current) return');
  });

  it('renders from state instead', () => {
    expect(renderBody()).toContain('hasStarted');
  });
});

describe('an unknown URL has a screen', () => {
  it('app/+not-found.tsx exists', () => {
    // Reachable in normal use, not only by mistyping: router.replace after
    // creating or deleting a set rewrites the URL, and an installed PWA
    // reopened on a deep link rebuilds the stack from that URL alone.
    expect(existsSync(join('app', '+not-found.tsx'))).toBe(true);
  });

  it('offers a way out and builds it from the existing kit', () => {
    const source = read('app', '+not-found.tsx');
    expect(source).toContain('export default function');
    expect(source).toContain('src/ui/components');
    expect(source).toContain('Button');
  });

  it('is registered on the stack, so the header is not "+not-found"', () => {
    const layout = read('app', '_layout.tsx');
    expect(layout).toContain('"+not-found"');
    expect(layout).toMatch(/\+not-found[\s\S]{0,120}backable/);
  });

  it('says nothing technical', () => {
    // The project's banned-words rule: no route patterns, no status codes.
    const source = read('app', '+not-found.tsx');
    const shown = source.match(/<(Title|Body)>([\s\S]*?)<\/\1>/g)?.join(' ') ?? '';
    expect(shown).not.toMatch(/\b404\b|route|URL|path/i);
  });
});
