/**
 * Can each tab actually be scrolled, at phone width?
 *
 * ## Why this exists
 *
 * Reported from daily use on an iPhone, 2026-09-12: the four tab screens could
 * not be scrolled, and Progress and Settings opened already at the bottom with
 * no way back up.
 *
 * **Nothing in the test suite could have caught it.** `tests/boot.test.ts`
 * runs the built bundle under **jsdom, which computes no layout at all** — it
 * can prove the app mounts and nothing more. And every screenshot ever taken
 * at 393px in this project was of a *deck*, which lives in the root stack, not
 * in the `(tabs)` group. The one layout that was broken was the one layout
 * never photographed at the width where it breaks.
 *
 * So the instrument is a real browser, measuring rather than looking: a
 * screenshot of a stuck screen and a screenshot of a working one can look
 * identical if the content happens to fit.
 *
 * ## What it measures, and why each number
 *
 *  - `scrollTop` on load — a screen that opens part-way down is the reported
 *    symptom, and the only one a static picture cannot show.
 *  - Whether ANY element is genuinely scrollable. If nothing is, the screen is
 *    frozen however tall its content.
 *  - Whether content overflows an ancestor that clips it (`overflow: hidden`),
 *    which is content nobody can reach by any gesture.
 *  - Whether scrolling to the top is possible: set `scrollTop = 0` and read it
 *    back. In a `column-reverse` container the top can be unreachable, and
 *    this is what proves it either way.
 *
 * Run:
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/scroll-probe.ts
 *
 * Needs TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD. Reads only.
 */
import { openPage } from './screenshot';

const TABS = ['/', '/notes', '/progress', '/settings'] as const;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

/**
 * Narrow enough to be a phone, and the width the report came from.
 *
 * The HEIGHT is adjustable and that matters more than it looks. At 852 the
 * test account's screens all fit, so nothing scrolls and the probe reports
 * "ok" while proving nothing — the content has to overflow before scrolling
 * can be tested at all. A real iPhone is also nowhere near 852 of USABLE
 * height once Safari's toolbars are on screen, and the owner has nine sets
 * where this account has two.
 */
const PHONE_WIDTH = arg('--width', 393);
const PHONE_HEIGHT = arg('--height', 852);

interface Finding {
  route: string;
  initialScrollTop: number;
  scrollers: { tag: string; cls: string; scrollHeight: number; clientHeight: number }[];
  clipped: { tag: string; cls: string; contentHeight: number; boxHeight: number }[];
  canReachTop: boolean;
  bodyOverflowsWindow: boolean;
  innerHeight: number;
  rootHeight: number;
  rootContent: number;
  declared: { tag: string; cls: string; scrollHeight: number; clientHeight: number }[];
}

async function main() {
  const page = await openPage({ width: PHONE_WIDTH, height: PHONE_HEIGHT, dark: true });
  const findings: Finding[] = [];

  try {
    for (const route of TABS) {
      await page.goto(route);
      // Let the screen settle: a tab that has just mounted may still be
      // laying out, and a measurement taken mid-layout is noise.
      await page.waitFor(
        `(document.querySelector('#root')?.innerText.trim().length ?? 0) > 0 ? 'y' : ''`,
        `content on ${route}`,
      );

      const raw = await page.evaluate<string>(`(() => {
        const info = (e) => ({
          tag: e.tagName,
          cls: (e.getAttribute('class') || '').slice(0, 40),
        });
        const all = [...document.querySelectorAll('*')];

        // Anything that can actually be scrolled by more than a rounding error.
        const scrollers = all
          .filter((e) => {
            const s = getComputedStyle(e);
            const scrolls = /auto|scroll/.test(s.overflowY);
            return scrolls && e.scrollHeight - e.clientHeight > 4;
          })
          .map((e) => ({ ...info(e), scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }));

        // Content taller than a box that clips it: unreachable by any gesture.
        const clipped = all
          .filter((e) => {
            const s = getComputedStyle(e);
            return s.overflowY === 'hidden' && e.scrollHeight - e.clientHeight > 4;
          })
          .map((e) => ({ ...info(e), contentHeight: e.scrollHeight, boxHeight: e.clientHeight }));

        // Can the top be reached? Ask the document and every real scroller,
        // then put each back so the next measurement starts where it found it.
        const scrollerEls = all.filter((e) => {
          const s = getComputedStyle(e);
          return /auto|scroll/.test(s.overflowY) && e.scrollHeight - e.clientHeight > 4;
        });
        let canReachTop = true;
        for (const el of [document.scrollingElement, ...scrollerEls]) {
          if (!el) continue;
          const before = el.scrollTop;
          el.scrollTop = 0;
          if (el.scrollTop > 4) canReachTop = false;
          el.scrollTop = before;
        }

        // Every element that DECLARES itself scrollable, overflowing or not.
        // Without this, "0 scrollable" is ambiguous: it could mean the layout
        // is broken, or simply that the content happened to fit — and those
        // want opposite responses.
        const declared = all
          .filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY))
          .map((e) => ({ ...info(e), scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }));

        const root = document.getElementById('root');
        return JSON.stringify({
          initialScrollTop: document.scrollingElement.scrollTop,
          scrollers,
          clipped,
          canReachTop,
          bodyOverflowsWindow: document.body.scrollHeight - window.innerHeight > 4,
          innerHeight: window.innerHeight,
          rootHeight: root ? root.clientHeight : -1,
          rootContent: root ? root.scrollHeight : -1,
          declared,
        });
      })()`);

      findings.push({ route, ...(JSON.parse(raw) as Omit<Finding, 'route'>) });
    }
  } finally {
    await page.close();
  }

  console.log(`${'='.repeat(78)}\nSCROLL PROBE — ${PHONE_WIDTH}x${PHONE_HEIGHT}\n${'='.repeat(78)}`);
  let broken = 0;

  for (const f of findings) {
    /**
     * The real signature, and the first version of this probe missed it.
     *
     * A scroll container that was never given a bounded height simply GROWS to
     * its content: box 1826 for 1826 of content, so `scrollHeight ===
     * clientHeight` and it reports itself perfectly healthy while scrolling
     * nothing. The page is then taller than the window and the excess is
     * clipped by an ancestor.
     *
     * Checking for clipped overflow does not catch it either, because the
     * container is `column-reverse`: overflow goes off the TOP, and
     * `scrollHeight` only ever counts overflow in the forward direction. The
     * ancestor honestly reports content 420 in a 420 box while 1400px of the
     * screen sits above it, unreachable.
     *
     * So the question is not "does anything scroll" but "is the scroller
     * BOUNDED" — is its box bigger than the window it lives in.
     */
    const unbounded = f.declared.filter((d) => d.clientHeight > f.innerHeight + 4);
    const stuck = f.scrollers.length === 0 && f.clipped.length > 0;
    const opensLow = f.initialScrollTop > 4;
    const bad = unbounded.length > 0 || stuck || opensLow || !f.canReachTop;
    if (bad) broken++;

    console.log(`\n  ${bad ? 'BROKEN' : '  ok  '}  ${f.route}`);
    console.log(`      scrollable elements : ${f.scrollers.length}`);
    for (const s of f.scrollers) {
      console.log(`        ${s.tag} ${s.cls} — ${s.scrollHeight} of ${s.clientHeight} visible`);
    }
    console.log(`      clipped overflow    : ${f.clipped.length}`);
    for (const c of f.clipped) {
      console.log(
        `        ${c.tag} ${c.cls} — ${c.contentHeight}px of content in a ${c.boxHeight}px box, hidden`,
      );
    }
    console.log(`      declared scrollable : ${f.declared.length}`);
    for (const d of f.declared) {
      console.log(`        ${d.tag} ${d.cls} — content ${d.scrollHeight} in box ${d.clientHeight}`);
    }
    console.log(`      viewport / #root    : ${f.innerHeight} / box ${f.rootHeight}, content ${f.rootContent}`);
    for (const u of unbounded) {
      console.log(
        `      UNBOUNDED SCROLLER  : box ${u.clientHeight} in a ${f.innerHeight} viewport — it grew to fit its content instead of scrolling`,
      );
    }
    console.log(`      opens at scrollTop  : ${f.initialScrollTop}`);
    console.log(`      can reach the top   : ${f.canReachTop ? 'yes' : 'NO'}`);
  }

  console.log(`\n${'-'.repeat(78)}`);
  console.log(
    broken === 0
      ? `  All ${findings.length} tabs scroll, open at the top, and clip nothing.`
      : `  ${broken} of ${findings.length} tabs are BROKEN at phone width.`,
  );
  process.exitCode = broken === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
