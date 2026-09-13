import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  //
  // The guard MOVED rather than weakened. The picker used to be three hand
  // rolled Buttons in each of three screens, so this had to check three copies
  // of the same JSX; §23.2 records them drifting exactly once, with quiz
  // shipping without its counts. There is now one `LevelSegment`, so the
  // question splits: does each screen hand it the counts, and does the control
  // actually draw them.
  const screens = ['flashcards.tsx', 'quiz.tsx', 'blanks.tsx'];

  for (const screen of screens) {
    it(`${screen} hands its counts to the shared segment`, () => {
      const source = read('app', 'set', '[id]', screen);
      expect(source).toMatch(/<LevelSegment[^>]*counts=\{countByLevel\}/s);
    });
  }

  it('the segment renders the count as its own element, not inside the label', () => {
    // Concatenating it into the label is what made "Remember 5" wrap to two
    // lines while "Apply 4" did not.
    const source = read('src', 'ui', 'segment.tsx');
    expect(source).toContain('{n}');
    expect(source).not.toMatch(/\$\{l\.label\}\s*\$\{/);
  });

  it('no screen declares its own copy of LEVELS any more', () => {
    for (const screen of screens) {
      const source = read('app', 'set', '[id]', screen);
      expect(source).not.toMatch(/const LEVELS/);
    }
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

  it('opens from Nomi standing on Home, not from a pill in a heading', () => {
    // The owner, 2026-09-13: "I don't like how Nomi is just looking like a
    // button that needs to be clicked." The pill in Study's and Progress's
    // headings became a card Nomi stands on, on Home (NOTES §36).
    expect(code(home)).toContain('<NomiCard');
    for (const tab of tsxUnder(join('app', '(tabs)'))) {
      expect(code(readFileSync(tab, 'utf8')), tab).not.toContain('NomiButton');
    }
  });

  it("Progress's three render branches keep their heading", () => {
    // Progress returns early for loading and for nothing-answered-yet. Hand
    // editing three branches is how two of them quietly lose their title.
    const rows = progress.match(/<TitleRow title="Progress" \/>/g) ?? [];
    expect(rows).toHaveLength(3);
  });

  it('navigates to the route the stack registered, from Home and from the ✦ panel', () => {
    expect(home).toContain("router.push('/nomi')");
    expect(read('src', 'ui', 'assistant.tsx')).toContain("router.push('/nomi')");
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

  it('is the conversation itself, with no description cards', () => {
    // "there's TOO MUCH text/cards. too much descriptions! remove that." —
    // the owner, on the screen this replaced (NOTES §36). It reads through the
    // data layer, never the database directly.
    const screen = code(read('app', 'nomi.tsx'));
    expect(screen).toContain('<Composer');
    expect(screen).toContain('<ChatHistory');
    expect(screen).not.toMatch(/<Card\b|<Body\b/);
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

  it('the ✦ panel and Nomi’s screen are one conversation, not two AIs', () => {
    // askAssistant was the one-question operation; both windows now read the
    // same conversation, so a question asked about a card continues in the full
    // chat (NOTES §36).
    expect(code(read('src', 'ui', 'assistant.tsx'))).toContain('useNomiConversation(context)');
    expect(code(read('app', 'nomi.tsx'))).toContain('useNomiConversation(context)');
  });

  it('is hidden on Nomi’s own screen, where the whole screen is the conversation', () => {
    expect(read('app', '_layout.tsx')).toContain("segments[0] !== 'nomi'");
  });

  it('shows the same owl on both surfaces, and keeps ✦ on the floating button', () => {
    // This guard used to demand ✦ in both files: two different marks would make
    // one companion look like two features. It MOVED rather than weakened
    // (NOTES §35). The two surfaces now differ by role — the pill goes to
    // Nomi's screen, the ✦ asks about what is in front of you — and share an
    // identity, which is the owl. So the question splits the same way: is the
    // owl in both, and is the ✦ still drawn (in code, not in a comment).
    expect(code(read('src', 'ui', 'assistant.tsx'))).toContain('<NomiCharacter');
    expect(code(read('src', 'ui', 'nomi.tsx'))).toContain('<NomiCharacter');
    expect(code(read('src', 'ui', 'assistant.tsx'))).toContain('{GLYPH.nomi}');
    expect(read('src', 'ui', 'glyphs.tsx')).toContain("nomi: '✦'");
  });

  it('names Nomi in the copy the student reads', () => {
    expect(read('src', 'ui', 'assistant.tsx')).toContain('Ask Nomi');
  });

  it('leaves the D13 privacy copy exactly as approved — including its extension', () => {
    // The owner's instruction, pinned rather than remembered: this paragraph is
    // approved copy that D13 says must not be paraphrased smaller, and the word
    // Nomi does not enter it. Extended with his approval on 2026-09-13, when
    // Nomi began sending what it knows about the student (NOTES §36).
    const settings = read('app', '(tabs)', 'settings.tsx');
    expect(settings).toContain(
      'The study assistant works the same way — what you ask it, the notes it looks at, and',
    );
    expect(settings).toContain('what it knows about your studying (your name, sets, streak and progress) are sent to');
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

/** Every .tsx file under a directory, as paths relative to the repo root. */
function tsxUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => join(dir, f));
}

describe('symbols and waiting are each said one way', () => {
  const surfaces = () => [...tsxUnder('app'), ...tsxUnder(join('src', 'ui'))];

  it('no screen types a symbol in directly — they come from GLYPH', () => {
    // Seven symbols were typed inline across six files, which is how two
    // chevrons become two different characters (NOTES §35). Comments are
    // stripped first: explaining a glyph in prose is fine.
    for (const file of surfaces().filter((f) => !f.endsWith('glyphs.tsx'))) {
      expect(code(readFileSync(file, 'utf8')), file).not.toMatch(/[›‹⋯✕✓✗✦✎❏◕⚙↑☰]/);
    }
  });

  it('no screen hand-writes "Loading…" — it is LoadingState', () => {
    // It was eight copies of bare muted text.
    for (const file of surfaces().filter((f) => !f.endsWith('components.tsx'))) {
      expect(code(readFileSync(file, 'utf8')), file).not.toContain('Loading…');
    }
  });
});

describe('Nomi guides, the pet celebrates', () => {
  it('no screen asks Nomi to encourage or celebrate', () => {
    // `encouraging` and `success` are built into src/core/nomi-motion.ts and
    // deliberately unused. The streak pet owns encouragement; two animals
    // cheering the same answer would make them the same thing. Using either
    // is a decision to take on purpose, and this is where it gets noticed.
    const surfaces = [...tsxUnder('app'), ...tsxUnder(join('src', 'ui'))].filter(
      (f) => !f.endsWith('nomi-character.tsx'),
    );
    for (const file of surfaces) {
      expect(code(readFileSync(file, 'utf8')), file).not.toMatch(/['"](encouraging|success)['"]/);
    }
  });
});

describe('Nomi moves without getting in the way', () => {
  const renderer = code(read('src', 'ui', 'nomi-character.tsx'));

  it('honours the reduce-motion setting, and follows it when it changes', () => {
    expect(renderer).toContain('isReduceMotionEnabled');
    expect(renderer).toContain("'reduceMotionChanged'");
  });

  it('stops every animation and timer it starts', () => {
    expect(renderer).toContain('animation.stop()');
    expect(renderer).toContain('clearTimeout(timer)');
  });

  it('pauses while the app is in the background', () => {
    expect(renderer).toContain('AppState.addEventListener');
  });

  it('never listens to a value per frame, which would mean a render per frame', () => {
    expect(renderer).not.toMatch(/\.addListener\(/);
  });

  it('is the only file that knows the owl is made of pictures', () => {
    const others = [...tsxUnder('app'), ...tsxUnder(join('src', 'ui'))].filter(
      (f) => !f.endsWith('nomi-character.tsx'),
    );
    for (const file of others) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/nomi-(body|wing|eyes)/);
    }
  });
});

describe("Nomi's screen describes the present", () => {
  const screen = read('app', 'nomi.tsx');

  it('makes no promises in the future tense', () => {
    // It was a roadmap — "Nomi will become…", "Soon Nomi will also know…" —
    // and a screen describing a product that does not exist yet reads as a
    // product that does not work.
    //
    // BOTH files. The screen's opening line is drawn by NomiHero in
    // src/ui/nomi.tsx, and the first version of this guard read only the
    // route file — a mutation putting "will become" back into the hero
    // sailed straight past it.
    for (const source of [screen, read('src', 'ui', 'nomi.tsx')]) {
      expect(code(source)).not.toMatch(/\bwill become\b|\bSoon\b|\bwill also\b/);
    }
  });

  it('opens a new conversation with Nomi saying hello, not a description of Nomi', () => {
    expect(code(screen)).toContain('<NomiWelcome');
    expect(code(screen)).toContain('homeLine(chat.snapshot)');
  });
});

describe('each screen gives its weight to the thing you came to do', () => {
  it('Home gives Continue the filled button, and + New set a compact one', () => {
    // "+ New set" was the only filled button on the screen you open every day,
    // outweighing Continue — the daily action (NOTES §35). The card is shaded
    // and its heading sits above it, from the owner's reference (§36).
    const home = code(read('app', '(tabs)', 'index.tsx'));
    expect(home).toContain('action={<PillButton label="+ New set"');
    expect(home).toMatch(/<SectionRow title="Continue where you left off" \/>\s*<ContinueCard[\s\S]*?actionLabel=/);
    expect(code(read('src', 'ui', 'home.tsx'))).toMatch(/backgroundColor: t\.feature[\s\S]*?<Button/);
  });

  it('Home greets the student by name, with their picture top right opening Settings', () => {
    const home = code(read('app', '(tabs)', 'index.tsx'));
    expect(home).toContain('<GreetingHeader');
    expect(home).toContain("onAvatar={() => router.push('/settings')}");
  });

  it('Delete my data also deletes Nomi chats and profile pictures', () => {
    const sets = code(read('src', 'data', 'sets.ts'));
    expect(sets).toContain("from('nomi_conversations').delete()");
    expect(sets).toContain('removeAvatarPhotos()');
  });

  it('the set screen offers its three modes as peers, not as one button and two lesser ones', () => {
    const set = code(read('app', 'set', '[id]', 'index.tsx'));
    expect(set).toContain('<OptionList');
    expect(set).not.toMatch(/label="Quiz"\s+variant="outline"/);
    for (const route of ['/flashcards`', '/quiz`', '/blanks`']) expect(set).toContain(route);
  });
});

describe('the tab layout bounds its content area', () => {
  /**
   * A phone-only scroll bug that nothing in this suite could have caught.
   *
   * `TabSlot` shipped with no style, so the content area was sized by its
   * content rather than by the space the tab bar left. The `ScrollView` inside
   * `Screen` inherited that unbounded height, and a scroll view exactly as
   * tall as its content scrolls nowhere. Because the phone container is
   * `column-reverse`, the excess went off the TOP — unreachable, which is why
   * Progress and Settings opened at the bottom with no way up.
   *
   * Measured at 393x420 before the fix: Settings rendered a 1826px scroll
   * container inside a 420px window, and 3 of 4 tabs were unscrollable.
   *
   * This is a source-text guard because the real check needs layout, and
   * `tests/boot.test.ts` runs on jsdom, which computes none. The measuring
   * instrument is `scripts/scroll-probe.ts`; this only stops the fix being
   * deleted by someone tidying the file.
   */
  const layout = read('app', '(tabs)', '_layout.tsx');

  it('gives TabSlot a flex so it fills the space the bar leaves', () => {
    const slot = /<TabSlot([^/]*)\/>/.exec(layout)?.[1] ?? '';
    expect(slot).toMatch(/flex:\s*1/);
  });

  it('does not carry a minHeight that does nothing', () => {
    // Deliberately asserting its ABSENCE. min-height:auto is the usual reason
    // a nested scroll container will not scroll on the web, so `minHeight: 0`
    // looks obligatory here — and react-native-web already sets it on every
    // View to match Yoga, measured in the built app. A build with flex:1
    // alone scrolls all four tabs. This keeps the line from being added back
    // as a superstition.
    const slot = /<TabSlot([^/]*)\/>/.exec(layout)?.[1] ?? '';
    expect(slot).not.toMatch(/minHeight/);
  });
});

describe('only the one-card screens are centred', () => {
  /**
   * Measured at 393x852 before the change: sign-in left 65% of the phone empty
   * under its single card, not-found 68%. Centring is for exactly that shape of
   * screen and no other (NOTES §35).
   */
  it('sign-in and not-found centre their single card', () => {
    expect(read('app', 'sign-in.tsx')).toContain('<Screen centered>');
    expect(read('app', '+not-found.tsx')).toContain('<Screen centered>');
  });

  it('no tab screen is centred — a list starts at the top, and TabSlot bounds the scroll', () => {
    for (const file of tsxUnder(join('app', '(tabs)'))) {
      expect(code(readFileSync(file, 'utf8')), file).not.toContain('<Screen centered');
    }
  });
});

describe('a finished deck clears what it promised', () => {
  /**
   * Reported from daily use, 2026-09-13, and reproduced on the test account the
   * same day: "Retry what you missed" opened on Understand and found nothing,
   * because every missed card was a Remember card; and after the student got
   * all five right, pressing back showed "7 due today · 5 cards to retry" until
   * a full reload (NOTES §36).
   */
  const decks = ['flashcards.tsx', 'quiz.tsx', 'blanks.tsx'];

  for (const deck of decks) {
    it(`${deck} records through useStudySession, so leaving refreshes Home and Progress`, () => {
      const source = code(read('app', 'set', '[id]', deck));
      expect(source).toContain('useStudySession(setId)');
      expect(source).not.toMatch(/\brecordAttempt\(/);
    });

    it(`${deck} builds its deck with deal(), so a retry deck is every missed card`, () => {
      expect(code(read('app', 'set', '[id]', deck))).toMatch(/\bdeal\(/);
    });
  }

  it('flashcards and quiz start on the level their link names, as initial state, never an effect', () => {
    for (const deck of ['flashcards.tsx', 'quiz.tsx']) {
      expect(code(read('app', 'set', '[id]', deck))).toMatch(
        /useState<Level>\(\(\) => startingLevel\(levelParam\)\)/,
      );
    }
  });

  it('the retry button counts the set it opens, and the due button opens the level the cards are at', () => {
    const progress = code(read('app', '(tabs)', 'progress.tsx'));
    expect(progress).toContain('data.retryTargetCount');
    expect(progress).toContain('data.dueTargetLevel');
    expect(code(read('app', 'set', '[id]', 'index.tsx'))).toContain('flashcards?level=${dueLevel}');
  });

  it('Home and Progress refetch when the app comes back to the front', () => {
    const home = code(read('app', '(tabs)', 'index.tsx'));
    expect(home.match(/refetchOnWindowFocus: true/g) ?? []).toHaveLength(2);
    expect(code(read('app', '(tabs)', 'progress.tsx'))).toContain('refetchOnWindowFocus: true');
  });
});
