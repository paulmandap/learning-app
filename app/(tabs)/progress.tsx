import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Body, Button, Card, LoadingState, Screen, TitleRow } from '../../src/ui/components';
import { StatePanel } from '../../src/ui/states';
import { GrowBar } from '../../src/ui/charts';
import { radius, space, type, useTheme } from '../../src/ui/theme';
import { useSessionStore } from '../../src/data/session';
import { fetchDashboard, EMPTY_DASHBOARD, type DashboardData } from '../../src/data/dashboard';
import {
  axisTicks,
  describeForecast,
  forecastDayLabel,
  forecastShortLabel,
  KNOWN_REPS,
  MIN_SECTION_ATTEMPTS,
  niceAxisTop,
  type SectionScore,
  type SectionTrend,
  type TrendDirection,
} from '../../src/core/progress';
import { formatBytes, MAX_USER_BYTES } from '../../src/core/storage';
import { PetStreak } from '../../src/ui/pet';
import { toPetSpecies } from '../../src/core/pet';
import { fetchProfile } from '../../src/data/profile';

/** The plotting height of a column chart. Enough for a week to read at a glance. */
const CHART_HEIGHT = 128;

/**
 * Progress — am I getting anywhere, and what should I look at next?
 *
 * The app has always recorded every answer (D8), every schedule (Phase 6) and
 * the section each card came from, and shown almost none of it back. This is
 * that data, answering the only two questions worth a screen.
 *
 * ## Five blocks, and nothing else
 *
 * The brief was explicit twice over: *"don't make the dashboard tab become too
 * much info. Keep it simple"*, and then *"just because i mentioned a few graphs
 * doesn't mean you put it all — only the appropriate ones."* So each block
 * answers one of those two questions and nothing is here for decoration: how
 * you are going, what you know, what is coming, where you stand, and one thing
 * to do next.
 *
 * **Two charts, both columns now.** The owner: *"everything is like a
 * horizontal bar chart. it feels so static … maybe vertical bar chart? like …
 * coming up this week graph, the days of the week could be at the x axis, and
 * on the y axis is the number? but make it clean not too detailed"* (NOTES
 * §37). So the week is seven columns against a count axis, what you know is
 * four columns with the count on each, and every bar grows in. "How each part
 * is going" stays as rows, because a section's name is a sentence and does not
 * fit under a column.
 *
 * There is deliberately no chart of accuracy over time: with a handful of
 * answers a day it would be mostly noise, and a noisy chart of a real measure
 * is worse than no chart.
 *
 * ## An empty screen is the normal case, not an error
 *
 * With one user and a few sessions most of this is blank at first, so every
 * block has a state that reads as encouragement rather than breakage — the
 * precedent is Phase 6's "Nothing waiting — you are on top of this one". A
 * screen that looks broken on day one is worse than no screen.
 *
 * ## Colour is never the only signal
 *
 * Green and amber carry the strong/weak split, but each list is also under a
 * plain-English heading and each row states its own score. Roughly one man in
 * twelve cannot separate the two, which is the same reason the quiz options
 * carry a tick and a cross rather than colour alone.
 */
export default function Progress() {
  const session = useSessionStore((s) => s.session);
  const router = useRouter();

  const { data = EMPTY_DASHBOARD, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => fetchDashboard(),
    enabled: !!session,
    // An installed app is reopened, not relaunched: without this, a morning's
    // Progress would still show last night's due count (NOTES §36).
    refetchOnWindowFocus: true,
  });

  if (isLoading) {
    return (
      <Screen>
        <TitleRow title="Progress" />
        <LoadingState />
      </Screen>
    );
  }

  // Nothing has been answered yet. Say what to do rather than showing four
  // empty blocks and a row of zeroes.
  if (data.totalAttempts === 0) {
    return (
      <Screen>
        <TitleRow title="Progress" />
        {/* Names the blocks it will fill in, in the words those blocks
            actually use. It said "what has stuck" and "worth another look"
            after those headings had been rewritten, which is how an empty
            state quietly stops describing the screen it introduces. */}
        <StatePanel kind="empty"
          title="Nothing to show yet"
          detail="Study a set and this fills in: how many days in a row you've kept going, what you know, what's coming up, and how each part of your notes is going."
          action={{ label: 'Go to your sets', onPress: () => router.push('/') }}
        />
        {/* Someone can have uploaded a large file and answered nothing yet —
            which is exactly when "how much room have I used?" gets asked. */}
        <Space data={data} />
      </Screen>
    );
  }

  return (
    <Screen>
      <TitleRow title="Progress" />
      <Streak data={data} />
      <Mastery data={data} />
      <Forecast data={data} />
      <Sections data={data} />
      <NextStep data={data} />
      <Space data={data} />
    </Screen>
  );
}

/**
 * How you are going: the pet, the streak, and what is waiting.
 *
 * The pet carries the streak now (see `src/ui/pet.tsx`). The exact number
 * stays alongside it rather than being replaced by a picture — a streak you
 * cannot read precisely is a streak you stop believing.
 *
 * What is deliberately NOT said, before and after: "keep it up or lose it".
 * The streak survives a day you have not studied yet (see `studyStreak`), so
 * threatening someone with a loss they have not incurred would be a lie, and
 * a pet makes that kind of pressure land harder rather than softer.
 */
function Streak({ data }: { data: DashboardData }) {
  const { streak, dueToday } = data;

  // Shared query key with Settings and the study screens, so this is a cache
  // read rather than another round trip — and the pet falls back to the
  // default while it loads, never to an empty space where a pet should be.
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });

  return (
    <Card>
      <PetStreak streak={streak} species={toPetSpecies(profile?.pet)} />
      {dueToday > 0 ? (
        <Body>
          {dueToday} card{dueToday === 1 ? '' : 's'} ready for review.
        </Body>
      ) : (
        <Body muted>Nothing due right now — you're on top of it.</Body>
      )}
    </Card>
  );
}

/**
 * What has stuck: four columns, each with its count, and what puts a card there.
 *
 * ## From one stacked bar to four columns
 *
 * It was a single horizontal stacked bar — part-to-whole, read against a common
 * baseline, and chosen over a donut for exactly that (a donut compares arc
 * angles, and needs SVG this project does not have). It was also the chart the
 * owner meant by "static". Four columns keep the common baseline, which is what
 * made the bar better than a ring, and show each band's size directly; the count
 * sits on its column, so nothing has to be read off an axis.
 *
 * The colours are the validated chart steps, not the UI tokens. Reusing `border`
 * for "Not started" measured **1.27:1** against the card: the segment was there
 * and could not be seen.
 */
function Mastery({ data }: { data: DashboardData }) {
  const t = useTheme();
  const { known, getting, needsWork, notStarted } = data.mastery;
  const total = known + getting + needsWork + notStarted;
  if (total === 0) return null;

  // Every band says what PUT a card there. The owner, on an earlier version:
  // "as a learner, i don't really know what's know well, getting there, and
  // not started. to me it's just a circle with different colors." A label
  // names a band; only the sentence beside it tells you how to move one.
  const bands = [
    {
      key: 'known',
      short: 'Know',
      label: 'You know these',
      hint: `right ${KNOWN_REPS} times in a row`,
      n: known,
      color: t.chart.known,
    },
    {
      key: 'getting',
      short: 'Getting there',
      label: 'Getting there',
      hint: 'right once or twice so far',
      n: getting,
      color: t.chart.learning,
    },
    {
      key: 'needsWork',
      short: 'Needs work',
      label: 'Needs work',
      hint: 'your last answer was wrong',
      n: needsWork,
      color: t.chart.tricky,
    },
    {
      key: 'notStarted',
      short: 'Not started',
      label: 'Not started',
      hint: "you haven't been asked these yet",
      n: notStarted,
      color: t.chart.neutral,
    },
  ];
  const tallest = Math.max(...bands.map((b) => b.n));

  return (
    <Card>
      <Body>What you know</Body>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          height: CHART_HEIGHT + type.label.lineHeight + space.xs,
          borderBottomWidth: 1,
          borderBottomColor: t.border,
        }}
      >
        {bands.map((b, i) => (
          <View
            key={b.key}
            accessible
            accessibilityLabel={`${b.label}: ${b.n}`}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: space.xs }}
          >
            <Text style={[type.label, { color: t.text }]}>{b.n}</Text>
            {b.n > 0 ? (
              <GrowBar
                direction="up"
                share={b.n / tallest}
                length={CHART_HEIGHT}
                thickness={36}
                color={b.color}
                delay={i * 70}
              />
            ) : null}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row' }}>
        {bands.map((b) => (
          <Text key={b.key} style={[type.caption, { flex: 1, textAlign: 'center', color: t.textMuted }]}>
            {b.short}
          </Text>
        ))}
      </View>

      {/* What puts a card in each band. The counts are on the columns, so
          this is only the sentence that says how to move one. */}
      <View style={{ gap: space.sm }}>
        {bands
          .filter((b) => b.n > 0)
          .map((b) => (
            <View key={b.key} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
              <View
                style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: b.color, marginTop: space.xs }}
              />
              <Text style={[type.caption, { flex: 1, color: t.textMuted }]}>
                <Text style={{ color: t.text }}>{b.label}</Text> — {b.hint}
              </Text>
            </View>
          ))}
      </View>
    </Card>
  );
}

/**
 * The week ahead — the one thing the screen could not say.
 *
 * ## What this replaced, and why
 *
 * It used to be "answers a day, last 30 days". The owner asked the question
 * that killed it: *"what is the relevance of that information? like 225
 * answers in 2 days. what do i gain from that?"*
 *
 * Nothing. It measured effort rather than learning, and it rewarded the
 * behaviour the scheduler exists to prevent — cramming drew the tallest bars
 * on the screen while spacing drew none. "Am I keeping at it?" was already
 * answered, better, by the streak and the pet directly above it.
 *
 * A forecast answers something nothing else in the app can: whether tonight is
 * light and tomorrow is heavy. It is the scheduler's own knowledge, which the
 * student otherwise discovers only by opening a deck.
 *
 * ## Columns, at the owner's request (NOTES §37)
 *
 * It was rows, because "Tomorrow" does not fit under a column. The labels have
 * since become weekday names, and three letters of one fit under anything — so
 * the owner's picture is now the chart: days along the bottom, the count up
 * the side, three numbers on the axis at most. Today is the first column and
 * its day is in bold. A day with nothing due has no bar and sits on the
 * baseline, which is the axis saying zero.
 *
 * Drawn with plain Views — a charting library would be a dependency for
 * something the layout engine already does.
 */
function Forecast({ data }: { data: DashboardData }) {
  const t = useTheme();
  const days = data.forecast;
  if (days.length === 0) return null;

  const top = niceAxisTop(Math.max(0, ...days.map((d) => d.due)));
  const ticks = axisTicks(top);
  const today = days[0]!.dayStart;
  const summary = describeForecast(days, today);
  const yOf = (value: number) => Math.min(CHART_HEIGHT - 1, CHART_HEIGHT - (value / top) * CHART_HEIGHT);

  return (
    <Card>
      <Body>Coming up this week</Body>

      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.xs }}>
        {/* The count, up the side. */}
        <View style={{ width: 22, height: CHART_HEIGHT }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {ticks.map((v) => (
            <Text
              key={v}
              style={[
                type.caption,
                {
                  position: 'absolute',
                  right: 0,
                  top: yOf(v) - type.caption.lineHeight / 2,
                  color: t.textMuted,
                },
              ]}
            >
              {v}
            </Text>
          ))}
        </View>

        <View style={{ flex: 1 }}>
          <View style={{ height: CHART_HEIGHT }}>
            {ticks.map((v) => (
              <View
                key={v}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: yOf(v),
                  height: 1,
                  backgroundColor: t.border,
                  // The baseline is the axis; the others only guide the eye.
                  opacity: v === 0 ? 1 : 0.45,
                }}
              />
            ))}
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-end' }}>
              {days.map((d, i) => (
                <View
                  key={d.dayStart}
                  accessible
                  accessibilityLabel={`${forecastDayLabel(d.dayStart, today)}: ${d.due} card${d.due === 1 ? '' : 's'}`}
                  style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}
                >
                  {d.due > 0 ? (
                    <GrowBar
                      direction="up"
                      // Never shorter than a few points: one card beside forty
                      // would otherwise round to nothing and read as none due.
                      share={Math.max(d.due / top, 4 / CHART_HEIGHT)}
                      length={CHART_HEIGHT}
                      thickness={18}
                      color={t.chart.series}
                      delay={i * 45}
                    />
                  ) : null}
                </View>
              ))}
            </View>
          </View>

          <View style={{ flexDirection: 'row', marginTop: space.xs }}>
            {days.map((d) => (
              <Text
                key={d.dayStart}
                style={[
                  type.caption,
                  d.dayStart === today
                    ? { flex: 1, textAlign: 'center', color: t.text, fontWeight: '700' }
                    : { flex: 1, textAlign: 'center', color: t.textMuted },
                ]}
              >
                {forecastShortLabel(d.dayStart)}
              </Text>
            ))}
          </View>
        </View>
      </View>

      {summary ? <Body muted>{summary}</Body> : null}
    </Card>
  );
}

/**
 * How each part is going, by the sections the notes are actually divided into.
 *
 * The heading was "Where you stand", which the owner disliked — and it was
 * vague in a way the card is not: it says nothing about what the rows are or
 * what would change them. "How each part is going" is the same words a person
 * would use to describe it out loud.
 */
function Sections({ data }: { data: DashboardData }) {
  const { strong, weak, tooEarly } = data.sections;

  if (strong.length === 0 && weak.length === 0) {
    return (
      <Card>
        <Body>How each part is going</Body>
        <Body muted>
          {tooEarly > 0
            ? // Says WHY it is empty. Without this the block looks broken to
              // someone who has just answered a handful of cards.
              `Answer a few more and this will show which parts of your notes are going well. ` +
              `Each part needs at least ${MIN_SECTION_ATTEMPTS} answers before it's worth judging.`
            : 'Study a set and this will show which parts are going well.'}
        </Body>
      </Card>
    );
  }

  return (
    <Card>
      <Body>How each part is going</Body>
      <SectionList heading="Going well" tone="ok" sections={strong} trends={data.trends} />
      <SectionList heading="Worth another look" tone="warn" sections={weak} trends={data.trends} />
      {tooEarly > 0 ? (
        <Body muted>
          {tooEarly} more part{tooEarly === 1 ? '' : 's'} of your notes {tooEarly === 1 ? 'needs' : 'need'}{' '}
          a few more answers before {tooEarly === 1 ? 'it' : 'they'} can be judged.
        </Body>
      ) : null}
    </Card>
  );
}

/**
 * Which way a section is going, in one word.
 *
 * ## Why a word and not an arrow, and why nothing at all is the usual answer
 *
 * The dashboard's own rule is that colour is never the only signal, and a bare
 * ↑ is colour's cousin: a shape carrying meaning nobody stated. "Climbing" and
 * "slipping" need no key.
 *
 * **Steady renders as nothing.** A row that says "steady" on every section
 * teaches the reader to stop looking at that column, and it would also be
 * indistinguishable at a glance from the far more common case: a section with
 * fewer than twenty recent answers, where the honest answer is that we do not
 * know yet. Only movement is worth the ink.
 */
function TrendWord({ direction }: { direction?: TrendDirection }) {
  const t = useTheme();
  if (!direction || direction === 'steady') return null;

  const climbing = direction === 'improving';
  return (
    <Text style={[type.label, { color: climbing ? t.ok : t.warnText }]}>
      {climbing ? 'climbing' : 'slipping'}
    </Text>
  );
}

function SectionList({
  heading,
  tone,
  sections,
  trends,
}: {
  heading: string;
  tone: 'ok' | 'warn';
  sections: SectionScore[];
  trends: SectionTrend[];
}) {
  const t = useTheme();
  if (sections.length === 0) return null;
  const color = tone === 'ok' ? t.ok : t.warnText;

  return (
    <View style={{ gap: space.tight }}>
      {/* The heading is the signal; the colour only reinforces it. */}
      <Text style={[type.label, { color, fontWeight: '700' }]}>{heading}</Text>
      {sections.map((s, i) => (
        <View key={s.section} style={{ gap: space.xs, paddingLeft: space.sm, paddingVertical: space.hair }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Text style={[type.body, { color: t.text, flex: 1 }]} numberOfLines={2}>
              {s.section}
            </Text>
            {/* A percentage, on the owner's call: "instead of 22 of 22, just
                make it in percentage like 100%".

                The old argument for "4 of 5" was that it carries its own
                sample size, which a bare 80% hides. That still holds in
                general — but not here, because nothing is ranked until it has
                MIN_SECTION_ATTEMPTS answers behind it, so the n=1 percentage
                the count was guarding against cannot reach this row. */}
            {/* Which way it is going, when there is enough history to say.
                Beside the percentage rather than under it, because the two are
                one thought: 43%, and climbing.

                THE TWO ARE DIFFERENT WINDOWS, and that is deliberate. The
                percentage is a lifetime rate over every answer ever given; the
                word is the last 60 days. So a section can read "7% climbing"
                — the 7% still carries a bad start the trend has left behind,
                which is exactly the encouraging thing to say. Anything that
                later prints the trend's own numbers must label the window.

                Absent is the normal case and means "not enough answers yet",
                NOT "holding level" — a section needs twenty before the rule
                will speak, and claiming a direction on six is noise 38% of the
                time (measured; see src/core/progress.ts). */}
            <TrendWord direction={trends.find((x) => x.section === s.section)?.direction} />
            <Text style={[type.label, { color: t.textMuted }]}>{Math.round(s.accuracy * 100)}%</Text>
          </View>
          {/* A bar so two sections can be compared at a glance rather than by
              doing the division in your head — rows here, because a section's
              name is a sentence. It grows in with the columns above. */}
          <View style={{ height: 6, borderRadius: 3, backgroundColor: t.bg, overflow: 'hidden' }}>
            <GrowBar direction="right" share={s.accuracy} thickness={6} color={color} delay={i * 60} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * One thing to do next.
 *
 * A single action, not a menu. The whole screen exists to end in a decision,
 * and offering three buttons would put that decision back on the student.
 *
 * ## It used to name a decision and then not take it
 *
 * All three branches called `router.push('/')`, so "Retry what you missed (12)"
 * read the missed pile, counted it, put the number on a button and then dropped
 * you on the list of sets to find it yourself. The screen's whole purpose is its
 * last line and the last line did nothing — which is a worse failure than having
 * no button, because the label is a promise.
 *
 * The destinations are the ones Home already uses (`/set/:id/flashcards?retry=1`
 * for the missed pile), so there is one retry route in the app rather than two.
 *
 * **A missing target falls back to the set list rather than building a route
 * from nothing.** `retryTarget` and `dueTarget` are null exactly when there is
 * no set worth opening, and `/set/null/flashcards` would be a broken screen
 * where the list is merely a plain one.
 */
function NextStep({ data }: { data: DashboardData }) {
  const router = useRouter();

  if (data.toRetry > 0 && data.retryTarget) {
    return (
      <Button
        // The count of the set the button opens, not of every set (§36).
        label={`Retry what you missed (${data.retryTargetCount})`}
        onPress={() => router.push(`/set/${data.retryTarget}/flashcards?retry=1`)}
      />
    );
  }
  if (data.dueToday > 0 && data.dueTarget) {
    // Straight into the deck, not to the set screen: the flashcard queue is
    // already ordered due-first (`reviewOrder`), so this lands on the card the
    // button is talking about.
    return (
      <Button
        label="Study what's due"
        onPress={() =>
          router.push(
            `/set/${data.dueTarget}/flashcards${data.dueTargetLevel ? `?level=${data.dueTargetLevel}` : ''}`,
          )
        }
      />
    );
  }
  return <Button label="Go to your sets" variant="outline" onPress={() => router.push('/')} />;
}

/**
 * How much room you have used, and how much there is.
 *
 * ## Why this is now always on, when it used to be silent
 *
 * The original instruction was *"don't show upfront everytime regarding their
 * limit … you can put it in the dashboard"*, so it appeared only above 80%.
 * Then the owner shared the app: *"i shared the link to my friend and he
 * suggested that it would be nice to see the limit and how much space they
 * consumed."*
 *
 * Both are satisfied by where it sits rather than by whether it shows. It is
 * on the Progress tab and nowhere else — never on Add notes, never on a study
 * screen, never in the way of making cards. Someone who wants the number can
 * find it; nobody is told about a limit while they are trying to work.
 *
 * The bar is here because a fraction is the actual question. "24 MB of 150 MB"
 * needs arithmetic to become "plenty left", and the bar answers that before the
 * words are read.
 */
function Space({ data }: { data: DashboardData }) {
  const t = useTheme();
  const { usedBytes, fraction, worthMentioning } = data.usage;
  const free = Math.max(0, MAX_USER_BYTES - usedBytes);

  // The validated chart steps, not the UI tokens — §14.1's lesson, which cost
  // a segment that was drawn at 1.27:1 and could not be seen. Amber only when
  // it is nearly gone, so the colour means something when it changes.
  const fill = worthMentioning ? t.chart.tricky : t.chart.learning;

  return (
    <Card>
      <Body>{worthMentioning ? 'Running low on space' : 'Space'}</Body>

      <View
        style={{
          height: 10,
          borderRadius: radius.sm,
          overflow: 'hidden',
          backgroundColor: t.chart.neutral,
        }}
      >
        {/* Never a zero-width sliver: a first small upload that renders as
            nothing reads as "not counted", which is the one thing a usage bar
            must not say. Empty stays genuinely empty. */}
        <View
          style={{
            width: `${usedBytes > 0 ? Math.max(2, fraction * 100) : 0}%`,
            height: '100%',
            backgroundColor: fill,
          }}
        />
      </View>

      {/* "0 bytes of 150 MB used" is how a developer says it, and `bytes` is
          on this project's own banned-words list — tests/storage.test.ts
          rejects it in the upload message for the same reason. */}
      <Body muted>
        {usedBytes === 0
          ? `Nothing stored yet · ${formatBytes(MAX_USER_BYTES)} free`
          : `${formatBytes(usedBytes)} of ${formatBytes(MAX_USER_BYTES)} used · ${formatBytes(free)} left`}
      </Body>

      {/* The way out, named only when it is needed. It is not obvious, and it
          is the good news: freeing space keeps every card and every answer. */}
      {worthMentioning ? (
        <Body muted>
          On a set you've finished with, "Free up space" removes the original file and keeps all
          your cards and progress.
        </Body>
      ) : null}
    </Card>
  );
}
