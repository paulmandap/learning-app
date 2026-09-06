import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Body, Button, Card, Screen, Title } from '../../src/ui/components';
import { radius, space, useTheme } from '../../src/ui/theme';
import { useSessionStore } from '../../src/data/session';
import { fetchDashboard, EMPTY_DASHBOARD, type DashboardData } from '../../src/data/dashboard';
import {
  describeForecast,
  forecastDayLabel,
  KNOWN_REPS,
  MIN_SECTION_ATTEMPTS,
  type SectionScore,
} from '../../src/core/progress';
import { formatBytes, MAX_USER_BYTES } from '../../src/core/storage';
import { PetStreak } from '../../src/ui/pet';
import { toPetSpecies } from '../../src/core/pet';
import { fetchProfile } from '../../src/data/profile';

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
 * **Two charts, and both had to earn it — and one was replaced when it turned
 * out not to have.** The streak is a hero number carried by the pet, not a
 * gauge. Mastery is part-to-whole, so a stacked bar — not the donut that was
 * asked for, for the reasons on `Mastery`. The third block used to plot answers
 * per day and now plots the week ahead: the owner asked what he gained from
 * "225 answers in 2 days" and the honest answer was nothing, because it
 * measured effort rather than learning. See `Forecast`.
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
  });

  if (isLoading) {
    return (
      <Screen>
        <Title>Progress</Title>
        <Body muted>Loading…</Body>
      </Screen>
    );
  }

  // Nothing has been answered yet. Say what to do rather than showing four
  // empty blocks and a row of zeroes.
  if (data.totalAttempts === 0) {
    return (
      <Screen>
        <Title>Progress</Title>
        <Card>
          <Body>Nothing to show yet — you haven't answered any cards.</Body>
          {/* Names the blocks it will fill in, in the words those blocks
              actually use. It said "what has stuck" and "worth another look"
              after those headings had been rewritten, which is how an empty
              state quietly stops describing the screen it introduces. */}
          <Body muted>
            Study a set and this fills in: how many days in a row you've kept going, what you
            know, what's coming up, and how each part of your notes is going.
          </Body>
          <Button label="Go to your sets" onPress={() => router.push('/')} />
        </Card>
        {/* Someone can have uploaded a large file and answered nothing yet —
            which is exactly when "how much room have I used?" gets asked. */}
        <Space data={data} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Progress</Title>
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
 * What has stuck: one stacked bar, four labelled counts.
 *
 * ## Why a stacked bar and not a donut
 *
 * This is part-to-whole, and for part-to-whole a horizontal stacked bar beats a
 * ring: shares are read against a common baseline instead of by comparing arc
 * angles, it survives being 340px wide on a phone, and the labels sit beside the
 * numbers rather than orbiting them. A donut would also need SVG — which is not
 * a dependency this project has — to draw something the guidance rates worse.
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

  // Every band says what PUT a card there. The owner, on the old version:
  // "as a learner, i don't really know what's know well, getting there, and
  // not started. to me it's just a circle with different colors." A label
  // names a band; only the sentence beside it tells you how to move one.
  const segments = [
    {
      key: 'known',
      label: 'You know these',
      hint: `right ${KNOWN_REPS} times in a row`,
      n: known,
      color: t.chart.known,
    },
    {
      key: 'getting',
      label: 'Getting there',
      hint: 'right once or twice so far',
      n: getting,
      color: t.chart.learning,
    },
    {
      key: 'needsWork',
      label: 'Needs work',
      hint: 'your last answer was wrong',
      n: needsWork,
      color: t.chart.tricky,
    },
    {
      key: 'notStarted',
      label: 'Not started',
      hint: "you haven't been asked these yet",
      n: notStarted,
      color: t.chart.neutral,
    },
  ].filter((s) => s.n > 0);

  return (
    <Card>
      <Body>What you know</Body>

      {/* A 2px gap in the SURFACE colour separates touching segments, rather
          than a border drawn round each — a stroke would add ink that is not
          data. The last segment carries no gap, so the bar ends flush. */}
      <View style={{ flexDirection: 'row', height: 14, borderRadius: radius.sm, overflow: 'hidden' }}>
        {segments.map((s, i) => (
          <View
            key={s.key}
            style={{
              flex: s.n,
              backgroundColor: s.color,
              marginRight: i < segments.length - 1 ? 2 : 0,
            }}
          />
        ))}
      </View>

      {/* Every segment is named, explained and counted, so the bar is a summary
          of the list rather than the only place the information lives. */}
      <View style={{ gap: space.sm }}>
        {segments.map((s) => (
          <View key={s.key} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: s.color,
                marginTop: 5,
              }}
            />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 14 }}>{s.label}</Text>
              <Text style={{ color: t.textMuted, fontSize: 12 }}>{s.hint}</Text>
            </View>
            <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{s.n}</Text>
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
 * ## Why rows and not columns
 *
 * Seven bars need seven labels, and "Tomorrow" does not fit under a 40px
 * column. Horizontal rows give each day its name in full, put the count where
 * it is read rather than hovering above a bar, and stay legible at 340px.
 * Thirty columns needed no labels and so could be vertical; seven do.
 *
 * Drawn with plain Views — a charting library would be a dependency for
 * something the layout engine already does.
 */
function Forecast({ data }: { data: DashboardData }) {
  const t = useTheme();
  const days = data.forecast;
  if (days.length === 0) return null;

  const busiest = Math.max(...days.map((d) => d.due));
  const today = days[0]!.dayStart;
  const summary = describeForecast(days, today);

  return (
    <Card>
      <Body>Coming up this week</Body>

      <View style={{ gap: 6 }}>
        {days.map((d) => (
          <View key={d.dayStart} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Text style={{ color: t.textMuted, fontSize: 13, width: 74 }}>
              {forecastDayLabel(d.dayStart, today)}
            </Text>

            <View style={{ flex: 1, height: 10, justifyContent: 'center' }}>
              {d.due > 0 ? (
                <View
                  style={{
                    // Never a zero-width sliver: one card due on a day where
                    // another holds forty would round below a pixel and read as
                    // nothing due, which is the one thing this must not say.
                    width: `${Math.max(4, (d.due / busiest) * 100)}%`,
                    height: 10,
                    borderRadius: 3,
                    backgroundColor: t.chart.series,
                  }}
                />
              ) : (
                // An empty day is drawn, not skipped — a free day is
                // information, and a missing row would just look like a bug.
                <View style={{ width: 10, height: 2, borderRadius: 1, backgroundColor: t.border }} />
              )}
            </View>

            <Text
              style={{
                color: d.due > 0 ? t.text : t.textMuted,
                fontSize: 13,
                fontWeight: d.due > 0 ? '600' : '400',
                width: 28,
                textAlign: 'right',
              }}
            >
              {d.due > 0 ? d.due : '—'}
            </Text>
          </View>
        ))}
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
      <SectionList heading="Going well" tone="ok" sections={strong} />
      <SectionList heading="Worth another look" tone="warn" sections={weak} />
      {tooEarly > 0 ? (
        <Body muted>
          {tooEarly} more part{tooEarly === 1 ? '' : 's'} of your notes {tooEarly === 1 ? 'needs' : 'need'}{' '}
          a few more answers before {tooEarly === 1 ? 'it' : 'they'} can be judged.
        </Body>
      ) : null}
    </Card>
  );
}

function SectionList({
  heading,
  tone,
  sections,
}: {
  heading: string;
  tone: 'ok' | 'warn';
  sections: SectionScore[];
}) {
  const t = useTheme();
  if (sections.length === 0) return null;
  const color = tone === 'ok' ? t.ok : t.warnText;

  return (
    <View style={{ gap: 6 }}>
      {/* The heading is the signal; the colour only reinforces it. */}
      <Text style={{ color, fontSize: 13, fontWeight: '700' }}>{heading}</Text>
      {sections.map((s) => (
        <View key={s.section} style={{ gap: 4, paddingLeft: space.sm, paddingVertical: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Text style={{ color: t.text, fontSize: 15, flex: 1 }} numberOfLines={2}>
              {s.section}
            </Text>
            {/* A percentage, on the owner's call: "instead of 22 of 22, just
                make it in percentage like 100%".

                The old argument for "4 of 5" was that it carries its own
                sample size, which a bare 80% hides. That still holds in
                general — but not here, because nothing is ranked until it has
                MIN_SECTION_ATTEMPTS answers behind it, so the n=1 percentage
                the count was guarding against cannot reach this row. */}
            <Text style={{ color: t.textMuted, fontSize: 13 }}>
              {Math.round(s.accuracy * 100)}%
            </Text>
          </View>
          {/* A bar so two sections can be compared at a glance rather than by
              doing the division in your head. It replaces the coloured left
              border, which carried the same signal less usefully — this is the
              measure itself, on a common baseline. */}
          <View style={{ height: 6, borderRadius: 3, backgroundColor: t.bg, overflow: 'hidden' }}>
            <View
              style={{
                width: `${Math.round(s.accuracy * 100)}%`,
                height: '100%',
                borderRadius: 3,
                backgroundColor: color,
              }}
            />
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
 */
function NextStep({ data }: { data: DashboardData }) {
  const router = useRouter();

  if (data.toRetry > 0) {
    return (
      <Button
        label={`Retry what you missed (${data.toRetry})`}
        onPress={() => router.push('/')}
      />
    );
  }
  if (data.dueToday > 0) {
    return <Button label="Study what's due" onPress={() => router.push('/')} />;
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
