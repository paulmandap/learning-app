/**
 * Does studying keep your place when you look at another level?
 *
 * The owner, on his own phone: *"let's say i'm 5 of 9 progress in answering
 * the flashcards in 'remember'. when i suddenly switched to 'apply' then went
 * back to 'remember' i lost my progress. it went to 0 of 9 progress again."*
 *
 * The cause was one shared `index` reset by an effect on every level change.
 * The fix is a position per level. **No unit test can see this**: the state
 * lives in a react-native screen, which this project's Vitest suite cannot
 * load, and the defect only appears in a sequence of taps. So it is checked
 * here, against the built bundle, the way it was found.
 *
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/study-probe.ts <set-id>
 *
 * Needs TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD, and a set belonging to that
 * user with cards at two different levels. Exits 1 on a regression.
 */
import { openPage } from './screenshot';

type Page = Awaited<ReturnType<typeof openPage>>;

/** The "3 of 9" the progress bar is showing, read off the bar itself. */
async function position(page: Page): Promise<string> {
  return page.evaluate<string>(`(() => {
    const el = [...document.querySelectorAll('*')]
      .find((n) => n.children.length === 0 && /^\\d+ of \\d+$/.test(n.textContent.trim()));
    return el ? el.textContent.trim() : 'none';
  })()`);
}

/**
 * The level buttons actually on screen, e.g. ["Remember 10", "Apply 4"].
 *
 * Read from the page rather than hardcoded: the counts are whatever that set
 * happens to hold, and a probe that only runs against one fixture is a probe
 * that stops being run.
 */
async function levelButtons(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`(() => {
    return [...document.querySelectorAll('div[role="button"], button, [tabindex]')]
      .map((n) => n.innerText.trim())
      .filter((s) => /^(Remember|Understand|Apply) [1-9]\\d*$/.test(s));
  })()`);
}

async function answerOne(page: Page) {
  // The desktop shortcut: right arrow is "got it". The card itself is the
  // pressable and its text is the question, so there is no stable label to
  // click, and the keyboard path grades without needing to flip first.
  await page.evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }))`,
  );
  await new Promise((r) => setTimeout(r, 600));
}

async function main() {
  const setId = process.argv[2];
  if (!setId) throw new Error('Usage: study-probe.ts <set-id>');

  const page = await openPage({ width: 393, height: 900, dark: true });
  try {
    await page.goto(`/set/${setId}/flashcards`);

    const buttons = await levelButtons(page);
    if (buttons.length < 2) {
      throw new Error(
        `That set has cards at fewer than two levels (${buttons.join(', ') || 'none'}), ` +
          'so there is no level to switch away to.',
      );
    }
    const [first, second] = buttons as [string, string];

    await page.click(first);
    await new Promise((r) => setTimeout(r, 700));
    console.log(`${first.padEnd(16)} start:      ${await position(page)}`);

    await answerOne(page);
    await answerOne(page);
    const afterTwo = await position(page);
    console.log(`${first.padEnd(16)} 2 answered: ${afterTwo}`);

    await page.click(second);
    await new Promise((r) => setTimeout(r, 700));
    console.log(`${second.padEnd(16)} switched:   ${await position(page)}`);

    await page.click(first);
    await new Promise((r) => setTimeout(r, 700));
    const back = await position(page);
    console.log(`${first.padEnd(16)} back:       ${back}`);

    const ok = back === afterTwo;
    console.log(ok ? '\nPASS — your place is kept' : `\nFAIL — was ${afterTwo}, came back to ${back}`);
    process.exit(ok ? 0 : 1);
  } finally {
    await page.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
