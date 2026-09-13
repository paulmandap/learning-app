/**
 * The gate for the teal/amber re-theme.
 *
 * §14.1 records the last palette change shipping a chart segment at **1.27:1**
 * against its card — invisible, and nobody saw it because "these colours look
 * fine" was the whole check. That validation covered the BLUE palette. Moving
 * to teal/amber invalidates it completely: 11 semantic roles across two modes
 * plus five chart fills, all of them new.
 *
 * So the palette does not ship until this passes. It is re-runnable, so it
 * also stops the next change from quietly regressing one pair.
 *
 * ## Thresholds, and why each one
 *
 *   text vs its surface        >= 4.5:1   WCAG AA for body text
 *   chart fill vs its surface  >= 3.0:1   §14.1's rule; a fill is not text
 *   accent fill vs page        >= 3.0:1   large UI element
 *   adjacent chart fills       ΔE >= 16   under deuteranopia AND protanopia
 *   hairline border vs card    >= 1.25:1  reported; see the note below
 *
 * The border floor is deliberately low and deliberately not 3:1, and 1.25 is
 * not arbitrary: it is what the product already accepts. The shipped LIGHT
 * border measures 1.27:1 by choice, while the DARK one was RAISED to 1.90:1
 * because at 1.26:1 it vanished on OLED. A stricter floor here would fail the
 * live design, which would make this validator wrong rather than strict. Both
 * numbers are printed so the trade-off stays visible.
 *
 * Run:
 *   npx tsx scripts/palette-check.ts
 */
import { contrastHex, deltaEHex } from '../src/core/color';
import { DARK, LIGHT } from '../src/core/palette';

interface Candidate {
  bg: string;
  card: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentText: string;
  danger: string;
  ok: string;
  warnBg: string;
  warnText: string;
  infoBg: string;
  infoText: string;
  chart: { known: string; learning: string; tricky: string; neutral: string; series: string };
}

/**
 * The palette under test is the SHIPPED one, imported from `src/ui/theme.ts`.
 *
 * Deliberately not a copy. A checker with its own private colours agrees with
 * itself forever while the app drifts away underneath it — which is exactly
 * how the backup's hand-kept table list failed four times running.
 *
 * Derived from the reference brand colours (Deep Teal #0B3C49, Warm Amber
 * #E5A134, Focus Green #3D8B63, Caution Orange #D98835, Error Red #864849),
 * adjusted where they did not clear a threshold. A reference sheet is picked
 * for how it looks in a mock-up, not measured against eleven surfaces in two
 * modes: the first candidate failed six checks, including green against amber
 * at 11.0 ΔE under protanopia.
 */
const light = LIGHT as unknown as Candidate;
const dark = DARK as unknown as Candidate;

const TEXT_MIN = 4.5;
const FILL_MIN = 3;
const BORDER_MIN = 1.25;
const DELTA_MIN = 16;

let failures = 0;

function check(label: string, got: number, min: number, unit = ':1') {
  const ok = got >= min;
  if (!ok) failures++;
  const shown = unit === ':1' ? got.toFixed(2) : got.toFixed(1);
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label.padEnd(42)} ${shown.padStart(6)}${unit}  (min ${min})`);
}

function report(mode: string, p: Candidate) {
  console.log(`\n${'='.repeat(78)}\n${mode.toUpperCase()}\n${'='.repeat(78)}`);

  console.log('\n  text');
  check('text on bg', contrastHex(p.text, p.bg), TEXT_MIN);
  check('text on card', contrastHex(p.text, p.card), TEXT_MIN);
  check('textMuted on bg', contrastHex(p.textMuted, p.bg), TEXT_MIN);
  check('textMuted on card', contrastHex(p.textMuted, p.card), TEXT_MIN);
  check('accentText on accent', contrastHex(p.accentText, p.accent), TEXT_MIN);
  check('danger on card', contrastHex(p.danger, p.card), TEXT_MIN);
  check('ok on card', contrastHex(p.ok, p.card), TEXT_MIN);
  check('warnText on warnBg', contrastHex(p.warnText, p.warnBg), TEXT_MIN);
  check('infoText on infoBg', contrastHex(p.infoText, p.infoBg), TEXT_MIN);

  console.log('\n  large elements and fills');
  check('accent fill on bg', contrastHex(p.accent, p.bg), FILL_MIN);
  check('accent fill on card', contrastHex(p.accent, p.card), FILL_MIN);
  for (const [name, hex] of Object.entries(p.chart)) {
    check(`chart.${name} on card`, contrastHex(hex, p.card), FILL_MIN);
  }

  console.log('\n  hairlines (reported, low floor by design)');
  check('border on card', contrastHex(p.border, p.card), BORDER_MIN);
  check('border on bg', contrastHex(p.border, p.bg), BORDER_MIN);

  console.log('\n  chart fills must stay apart under colour blindness');
  const fills = ['known', 'learning', 'tricky', 'neutral'] as const;
  for (const cvd of ['deuteranopia', 'protanopia'] as const) {
    for (let i = 0; i < fills.length; i++) {
      for (let j = i + 1; j < fills.length; j++) {
        const a = p.chart[fills[i]!];
        const b = p.chart[fills[j]!];
        check(`${fills[i]}/${fills[j]} (${cvd.slice(0, 5)})`, deltaEHex(a, b, cvd), DELTA_MIN, ' ΔE');
      }
    }
  }
}

report('light', light);
report('dark', dark);

console.log(`\n${'-'.repeat(78)}`);
console.log(
  failures === 0
    ? '  PALETTE PASSES. Every pair clears its threshold in both modes.'
    : `  ${failures} CHECK(S) FAILED. This palette does not ship.`,
);
process.exitCode = failures === 0 ? 0 : 1;
