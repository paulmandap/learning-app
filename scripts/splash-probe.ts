/**
 * What the screen holds the moment the splash goes (NOTES §45).
 *
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/splash-probe.ts [--runs 3] [--phone]
 *
 * The owner: *"it would be cool while in a splash, the app itself will load
 * too, saving users time."* Before changing anything, this says what happens
 * now: signed in as TEST_USER_A, it reloads `/` with a recorder that runs
 * before any of the page's own scripts, and logs in milliseconds since the
 * page began loading — the app's first drawing, Home's greeting, a loading
 * line, the list of sets, and the splash starting to fade and leaving — with
 * what was on screen at the instant the fade began.
 *
 * --phone: no cache, a CPU four times slower and a slow 4G connection (150 ms,
 * 1.6 Mb/s down), the nearest this harness gets to an iPhone opening the
 * installed app cold. Supabase is reached over the real network either way.
 */
import { openPage } from './screenshot';

const RECORDER = String.raw`(() => {
  const marks = [];
  const seen = new Set();
  window.__splash = marks;
  const mark = (what, extra) => {
    if (seen.has(what)) return;
    seen.add(what);
    marks.push({ at: Math.round(performance.now()), what, extra });
  };
  let splashSeen = false;
  const tick = () => {
    const root = document.getElementById('root');
    const text = root ? root.innerText : '';
    const state = {
      sets: /Your sets|Add your first notes/.test(text),
      loading: /Loading…/.test(text),
      greeting: /Welcome back/.test(text),
      continue: /Continue where you left off/.test(text),
      nomi: !!document.querySelector('[aria-label^="Talk to Nomi."]'),
    };
    if (text.trim().length > 0) mark('app drew');
    if (state.greeting) mark('greeting');
    if (state.loading) mark('loading line');
    if (state.sets) mark('sets');
    if (state.continue) mark('continue card');
    if (state.nomi) mark("Nomi's line");
    const splash = document.getElementById('splash');
    if (splash) splashSeen = true;
    if (splash && splash.classList.contains('gone')) mark('fade starts', state);
    if (splashSeen && !splash) mark('splash gone');
    if (performance.now() < 30000) setTimeout(tick, 10);
  };
  tick();
})()`;

async function main() {
  const args = process.argv.slice(2);
  const runsAt = args.indexOf('--runs');
  const runs = runsAt === -1 ? 3 : Number(args[runsAt + 1]);
  const phone = args.includes('--phone');

  const page = await openPage({ width: 393, height: 852, dark: true, reducedMotion: 'no-preference' });
  try {
    await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
    if (phone) {
      await page.cdp('Network.enable');
      await page.cdp('Network.setCacheDisabled', { cacheDisabled: true });
      await page.cdp('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
      });
      await page.cdp('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    console.log(`${phone ? 'phone: no cache, 4x CPU, slow 4G' : 'desktop: warm cache, no throttling'} · ${runs} runs`);

    for (let run = 1; run <= runs; run++) {
      await page.cdp('Page.reload', { ignoreCache: phone });
      type Mark = { at: number; what: string; extra?: Record<string, boolean> };
      let marks: Mark[] = [];
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          marks = (await page.evaluate<Mark[] | undefined>('window.__splash')) ?? [];
        } catch {
          continue; // the page is between documents
        }
        const done = marks.some((m) => m.what === 'splash gone') && marks.some((m) => m.what === 'sets');
        if (done) break;
      }
      // Anything that lands just after the last mark.
      await new Promise((r) => setTimeout(r, 1500));
      marks = (await page.evaluate<Mark[] | undefined>('window.__splash')) ?? marks;
      console.log(`\nrun ${run}`);
      for (const m of marks) {
        const extra = m.extra
          ? `   on screen: ${Object.entries(m.extra).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nothing yet'}`
          : '';
        console.log(`  ${String(m.at).padStart(6)} ms  ${m.what}${extra}`);
      }
    }
    const errors = page.logs().filter((l) => l.startsWith('[exception]') || l.startsWith('[error]'));
    if (errors.length) console.log(`\npage errors:\n  ${errors.join('\n  ')}`);
  } finally {
    await page.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
