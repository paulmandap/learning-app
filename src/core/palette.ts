/**
 * The colour palette, as data.
 *
 * ## Why this is in src/core and not in the theme
 *
 * `src/ui/theme.ts` imports `useColorScheme` from react-native, and that makes
 * the whole module unreachable from Node — esbuild cannot transform react
 * native's Flow source. So a validator that imported the theme could not run,
 * and the first version of `scripts/palette-check.ts` kept its own copy of the
 * colours instead.
 *
 * That copy is the failure mode this project has hit repeatedly: a checker
 * holding its own values agrees with itself forever while the app drifts away
 * underneath it, exactly as the backup's hand-kept table list did four times.
 *
 * Colour is data, not UI. Keeping it here means `theme.ts` and the validator
 * read the SAME bytes, and it is the src/core rule doing its job rather than
 * being worked around.
 *
 * Every value below is validated by `scripts/palette-check.ts` and must not be
 * changed without re-running it: NOTES §14.1 records a chart fill shipping at
 * 1.27:1 against its card, invisible, because "these look fine" was the check.
 */

/**
 * Chart fills, kept separate from the UI tokens on purpose.
 *
 * A colour that works as text or as a hairline is not a colour that works as a
 * FILL, and using the UI tokens for both was measurably wrong. Run through the
 * dataviz validator, the first attempt — reusing `border` for "Not started" and
 * `warnText` for "Tricky" — failed on contrast at **1.27:1** against the card.
 * That segment was effectively invisible.
 *
 * These steps are validated: every fill clears 3:1 against its surface, and the
 * worst adjacent pair separates by ΔE 16.1 under deuteranopia (light) and 17.1
 * under protanopia (dark). They are CHOSEN per mode rather than flipped — a
 * light-mode fill on a dark card fails contrast in the other direction.
 *
 * `neutral` is deliberately grey and deliberately fails the validator's chroma
 * floor: it means "no data yet", and an absence should not wear a hue. Identity
 * never rests on colour alone here anyway — every segment is labelled in text.
 */
export interface ChartPalette {
  /** Cards on a long interval — the good state. */
  known: string;
  /** Cards in progress. */
  learning: string;
  /** Cards repeatedly failed. */
  tricky: string;
  /** Never answered. Grey by intent. */
  neutral: string;
  /** Single-series marks: the activity columns. */
  series: string;
}

export interface Theme {
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
  /** Informational, not alarming. The privacy note is information. */
  infoBg: string;
  infoText: string;
  /**
   * The one card on a screen that should be done first — Home's Continue card.
   *
   * Shaded rather than bordered, from the owner's reference: *"the continue
   * card is darker or somewhat shaded? it lets the user think 'oh i should
   * prioritize this'"* (NOTES §36). Its own text roles, because the page's
   * muted grey does not clear 4.5:1 on a tinted surface in both modes.
   */
  feature: string;
  featureText: string;
  featureMuted: string;
  /** Fills for the Progress screen. See the note above `chartLight`. */
  chart: ChartPalette;
}

/**
 * The built-in profile faces: what someone sees before uploading a photo.
 *
 * The owner asked for defaults "like what Netflix does" (NOTES §36): a bright,
 * friendly square per person rather than a grey silhouette. Six hues, each with
 * two expressions, so twelve faces — enough that a handful of users rarely
 * share one.
 *
 * The same in both themes on purpose. A face is someone's picture; it should
 * not change colour when the phone switches to dark mode. The gate checks the
 * one pair that has to work — the features against the face — at the text
 * floor, because a face whose eyes you cannot see is not a face.
 */
export interface AvatarFace {
  bg: string;
  ink: string;
  expression: 'smile' | 'grin';
}

const FACE_HUES: { bg: string; ink: string }[] = [
  { bg: '#6cb7c9', ink: '#08222a' }, // teal, the app's own accent
  { bg: '#f0c07f', ink: '#3a2508' }, // amber
  { bg: '#7fcb9f', ink: '#0d2a1b' }, // green
  { bg: '#f0a39a', ink: '#3b1210' }, // coral
  { bg: '#b9a7e8', ink: '#1f1538' }, // lavender
  { bg: '#9cc3f0', ink: '#0f2238' }, // sky
];

export const AVATAR_FACES: readonly AvatarFace[] = FACE_HUES.flatMap((hue) => [
  { ...hue, expression: 'smile' as const },
  { ...hue, expression: 'grin' as const },
]);

export const LIGHT: Theme = {
  bg: '#f4f2ed',
  card: '#ffffff',
  text: '#11242b',
  textMuted: '#55666c',
  border: '#dcd8cf',
  accent: '#0b3c49',
  accentText: '#ffffff',
  danger: '#8a3d3d',
  ok: '#1f5a3e',
  warnBg: '#fdf1dc',
  warnText: '#6b4a12',
  infoBg: '#e6eef1',
  infoText: '#123c49',
  feature: '#bfd6d1',
  featureText: '#11242b',
  featureMuted: '#3b5157',
  chart: {
    known: '#1f5a3e',
    learning: '#0b3c49',
    tricky: '#b0691a',
    neutral: '#8a8f92',
    series: '#0b3c49',
  },
};

export const DARK: Theme = {
  bg: '#0e191e',
  card: '#16252b',
  text: '#e9efee',
  textMuted: '#9fb0b3',
  border: '#43575e',
  accent: '#6cb7c9',
  accentText: '#08222a',
  danger: '#f0b1ad',
  ok: '#7fcb9f',
  warnBg: '#33280f',
  warnText: '#f2d3a0',
  infoBg: '#152e36',
  infoText: '#a9d4de',
  feature: '#274a52',
  featureText: '#e9efee',
  featureMuted: '#b4c8cb',
  chart: {
    known: '#3f9b70',
    learning: '#8ecfe0',
    tricky: '#f0c07f',
    neutral: '#77838a',
    series: '#8ecfe0',
  },
};
