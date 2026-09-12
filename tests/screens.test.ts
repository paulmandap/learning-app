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

/**
 * Source with its comments removed.
 *
 * Needed because a docstring that EXPLAINS why something is absent contains the
 * very word an "is it absent?" check looks for. `app/nomi.tsx` documents that
 * it deliberately does not call `getNomiContext`, and a naive substring search
 * read that sentence as the call itself.
 *
 * Crude — a `//` inside a string literal would be eaten too — and adequate,
 * because it is only ever pointed at screens in this repo, none of which put a
 * URL in one.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
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

describe('Nomi has a way in and a place to go', () => {
  const home = read('app', '(tabs)', 'index.tsx');
  const progress = read('app', '(tabs)', 'progress.tsx');
  const layout = read('app', '_layout.tsx');

  it('has a route file', () => {
    expect(existsSync(join('app', 'nomi.tsx'))).toBe(true);
  });

  it('is registered on the stack, so the header is not "nomi"', () => {
    // Same reason as +not-found and set/[id]/blanks: an unregistered route
    // shows its own pattern to the user as the header title.
    expect(layout).toContain('name="nomi"');
    expect(layout).toMatch(/name="nomi"[\s\S]{0,80}Nomi/);
  });

  it('is pushed above the tabs with a back control', () => {
    // Nomi is a task you open, not a place in the bar, so it needs its own way
    // out — an installed PWA has no edge-swipe-back.
    expect(layout).toMatch(/name="nomi"[\s\S]{0,120}backable/);
  });

  it('opens from the heading of Study and Progress', () => {
    for (const source of [home, progress]) {
      expect(source).toContain('NomiButton');
      expect(source).toContain('TitleRow');
    }
  });

  it('appears on every one of Progress\'s three render branches', () => {
    // Progress returns early for loading and for nothing-answered-yet. Hand
    // editing three branches is how two of them quietly lose the control.
    const rows = progress.match(/<TitleRow title="Progress" action=\{<NomiButton \/>\} \/>/g) ?? [];
    expect(rows).toHaveLength(3);
  });

  it('navigates to the route the stack registered', () => {
    const button = read('src', 'ui', 'nomi.tsx');
    expect(button).toContain("router.push('/nomi')");
  });

  it('is NOT in the bottom navigation', () => {
    // The four tabs are the learning loop. A fifth for a companion would make
    // Nomi somewhere you go instead of studying.
    const tabs = read('app', '(tabs)', '_layout.tsx');
    expect(tabs).not.toMatch(/nomi/i);
  });

  it('leaves the four existing tabs exactly as they were', () => {
    const tabs = read('app', '(tabs)', '_layout.tsx');
    for (const href of ["href: '/'", "href: '/notes'", "href: '/progress'", "href: '/settings'"]) {
      expect(tabs).toContain(href);
    }
  });

  it('asks the database for nothing when opened', () => {
    // The screen holds space; it does not report progress it cannot know.
    // getNomiContext is the boundary Phase C wires up — until then, opening
    // Nomi must not cost a round trip.
    const screen = code(read('app', 'nomi.tsx'));
    expect(screen).not.toContain('useQuery');
    expect(screen).not.toContain('getNomiContext');
    expect(screen).not.toContain('supabase');
  });

  it('does not pretend to know how the student is doing', () => {
    // No invented figures. A companion that states a confident number it made
    // up is worse than one that says nothing, because it gets believed.
    const screen = read('app', 'nomi.tsx');
    const shown = screen.match(/<Body[^>]*>([\s\S]*?)<\/Body>/g)?.join(' ') ?? '';
    expect(shown).not.toMatch(/\d+%|\d+ cards? (due|wrong|missed)|you are \d+/i);
  });

  it('says nothing technical', () => {
    const screen = read('app', 'nomi.tsx');
    const shown = screen.match(/<(Title|Body|NomiSlot)[^>]*>([\s\S]*?)<\/\1>/g)?.join(' ') ?? '';
    expect(shown).not.toMatch(/\bmodel\b|\btoken\b|\bAPI\b|\bprompt\b|\bquery\b|\bendpoint\b/i);
  });
});

describe('the existing assistant still works, and is now called Nomi', () => {
  it('is still mounted once above the navigator', () => {
    // It survives navigation and keeps its panel open across screens. Moving it
    // inside the Stack would remount it on every route change.
    const layout = read('app', '_layout.tsx');
    expect(layout).toContain('<StudyAssistant />');
    expect(layout).toContain("segments[0] !== 'sign-in'");
  });

  it('still asks through askAssistant — one AI, not two', () => {
    const ui = read('src', 'ui', 'assistant.tsx');
    expect(ui).toContain('askAssistant');
  });

  it('wears the same ✦ as the header entry point', () => {
    // Two different marks would make one companion look like two features.
    expect(read('src', 'ui', 'assistant.tsx')).toContain('✦');
    expect(read('src', 'ui', 'nomi.tsx')).toContain('✦');
  });

  it('names Nomi in the copy the student reads', () => {
    expect(read('src', 'ui', 'assistant.tsx')).toContain('Ask Nomi');
  });

  it('leaves the D13 privacy copy exactly as approved', () => {
    // The owner's instruction, pinned rather than remembered: this paragraph is
    // approved copy that D13 says must not be paraphrased smaller, and the word
    // Nomi does not enter it. The app names Nomi everywhere except here.
    const settings = read('app', '(tabs)', 'settings.tsx');
    expect(settings).toContain(
      'The study assistant works the same way — what you ask it, and the notes it looks at to',
    );
    const notice = settings.slice(settings.indexOf('Where your notes go'), settings.indexOf('key + test'));
    expect(notice).not.toMatch(/nomi/i);
  });
});

describe('adaptive order reaches the two modes that ask for it, and no others', () => {
  const flashcards = read('app', 'set', '[id]', 'flashcards.tsx');
  const blanks = read('app', 'set', '[id]', 'blanks.tsx');
  const quiz = read('app', 'set', '[id]', 'quiz.tsx');

  for (const [name, source] of [['flashcards', flashcards], ['blanks', blanks]] as const) {
    it(`${name} deals with studyOrder`, () => {
      expect(code(source)).toContain('studyOrder(');
    });

    it(`${name} tells it which section each card is from`, () => {
      // Without the section accessor the queue still orders by struggle but
      // stops grouping, and a miss is followed by whatever happened to be next.
      expect(code(source)).toContain('section_title');
    });
  }

  it('quiz still shuffles, and does NOT deal adaptively', () => {
    // The per-round shuffle is the owner's: "make it randomized everytime i
    // opened the quiz." Answering in a memorised order tests the order as much
    // as the material, which is the thing the round seed exists to stop.
    expect(code(quiz)).toContain('shuffleSeeded(');
    expect(code(quiz)).not.toContain('studyOrder(');
  });

  it('no EFFECT changes the level — only the student does', () => {
    // Levels are exclusive at the owner's request, and the buttons carry counts
    // so the challenge is chosen knowingly. `setLevel` in an onPress is the
    // student tapping; `setLevel` inside a useEffect is the app deciding for
    // them, which is what Phase D was explicitly told not to build.
    //
    // Blanks is the single documented exception: it opens on a level that has
    // any blanks at all, because they land almost entirely in Remember, and it
    // stops the moment the student picks one themselves.
    const effectsIn = (source: string): string[] => {
      const out: string[] = [];
      let from = 0;
      for (;;) {
        const start = code(source).indexOf('useEffect(', from);
        if (start === -1) return out;
        out.push(code(source).slice(start, start + 400));
        from = start + 1;
      }
    };

    for (const source of [flashcards, quiz]) {
      expect(effectsIn(source).filter((e) => e.includes('setLevel('))).toEqual([]);
    }
    // Blanks does, and guards it.
    expect(effectsIn(blanks).some((e) => e.includes('setLevel('))).toBe(true);
    expect(code(blanks)).toContain('levelChosen');
  });

  it('the selector never filters — it only reorders', () => {
    // A deck that hid what was not due would tell someone who sat down to study
    // that there is nothing to study.
    const core = read('src', 'core', 'schedule.ts');
    const fn = core.slice(core.indexOf('export function studyOrder'));
    expect(fn).not.toMatch(/\.filter\([^)]*isDue/);
  });
});
