import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Body, Button, Card, Screen, Title } from '../../src/ui/components';
import { radius, space, useTheme } from '../../src/ui/theme';
import { useSessionStore } from '../../src/data/session';
import { fetchDashboard, EMPTY_DASHBOARD, type DashboardData } from '../../src/data/dashboard';
import { MIN_SECTION_ATTEMPTS, type SectionScore } from '../../src/core/progress';
import { formatBytes, MAX_USER_BYTES } from '../../src/core/storage';

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
 * you are going, what has stuck, whether it is becoming a habit, where you
 * stand, and one thing to do next.
 *
 * **Two charts, and both had to earn it.** The streak is a hero number, not a
 * gauge. Mastery is part-to-whole, so a stacked bar — not the donut that was
 * asked for, for the reasons on `Mastery`. The daily columns are the only form
 * showing something no number already says. There is deliberately no chart of
 * accuracy over time: with a handful of answers a day it would be mostly noise,
 * and a noisy chart of a real measure is worse than no chart.
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
          <Body muted>
            Study a set and this fills in: how many days in a row you've kept going, what has
            stuck, and which parts of your notes are worth another look.
          </Body>
          <Button label="Go to your sets" onPress={() => router.push('/')} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Progress</Title>
      <Streak data={data} />
      <Mastery data={data} />
      <Activity data={data} />
      <Sections data={data} />
      <NextStep data={data} />
      <Space data={data} />
    </Screen>
  );
}

/** How you are going: the streak, and what is waiting. */
function Streak({ data }: { data: DashboardData }) {
  const t = useTheme();
  const { streak, dueToday } = data;

  return (
    <Card>
      <Text style={{ fontSize: 28, fontWeight: '700', color: t.text }}>
        {streak > 0 ? `${streak} day${streak === 1 ? '' : 's'} in a row` : 'Start a new streak'}
      </Text>
      <Body muted>
        {streak > 0
          ? // Deliberately not "keep it up or lose it". The streak survives a
            // day you have not studied yet (see studyStreak), so threatening
            // someone with a loss they have not incurred would be a lie.
            'Answering a few cards today keeps it going.'
          : "Answer a card today and you're on one."}
      </Body>
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
  const { mastered, learning, struggling } = data.mastery;
  const fresh = data.mastery.new;
  const total = mastered + learning + struggling + fresh;
  if (total === 0) return null;

  const segments = [
    { key: 'mastered', label: 'Known well', n: mastered, color: t.chart.known },
    { key: 'learning', label: 'Getting there', n: learning, color: t.chart.learning },
    { key: 'struggling', label: 'Tricky', n: struggling, color: t.chart.tricky },
    { key: 'new', label: 'Not started', n: fresh, color: t.chart.neutral },
  ].filter((s) => s.n > 0);

  return (
    <Card>
      <Body>What has stuck</Body>

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

      {/* Every segment is named and counted, so the bar is a summary of the
          list rather than the only place the information lives. */}
      <View style={{ gap: 4 }}>
        {segments.map((s) => (
          <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <View
              style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: s.color }}
            />
            <Text style={{ color: t.textMuted, fontSize: 14, flex: 1 }}>{s.label}</Text>
            <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{s.n}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

/**
 * Answers per day over the last month — the one thing the screen could not say.
 *
 * ## Why columns, and why this is the chart that earns its place
 *
 * The job is change over time for a single series, which is a line or a column
 * chart. Columns win here because the values are discrete daily counts and the
 * gaps matter: a day with no study has to look like a gap, and a line drawn
 * through it implies study that did not happen.
 *
 * It is also the only form on this screen showing something no number already
 * says. The streak is a hero figure, mastery is part-to-whole — both answered.
 * "Is this becoming a habit?" was not, and a shape answers it at a glance in a
 * way that "1 day in a row" cannot.
 *
 * Drawn with plain Views: thirty columns is thirty flex children, and a
 * charting library would be a dependency for something the layout engine
 * already does.
 */
function Activity({ data }: { data: DashboardData }) {
  const t = useTheme();
  const days = data.activity;
  if (days.length === 0) return null;

  const busiest = Math.max(...days.map((d) => d.answers));
  if (busiest === 0) return null;

  const studied = days.filter((d) => d.answers > 0).length;
  const total = days.reduce((n, d) => n + d.answers, 0);

  return (
    <Card>
      {/* The title names the series, so a one-series chart needs no legend box
          — a single swatch would only restate this line. */}
      <Body>Answers a day, last {days.length} days</Body>

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 64, gap: 2 }}>
        {days.map((d) => {
          // A day WITH answers never renders as nothing: a 1-answer day on a
          // 40-answer scale rounds to under a pixel and would read as a day off,
          // which is the one thing this chart must not get wrong.
          const height = d.answers === 0 ? 2 : Math.max(4, (d.answers / busiest) * 64);
          return (
            <View
              key={d.dayStart}
              style={{
                flex: 1,
                height,
                // Rounded at the data end, square at the baseline.
                borderTopLeftRadius: 3,
                borderTopRightRadius: 3,
                backgroundColor: d.answers === 0 ? t.border : t.chart.series,
              }}
            />
          );
        })}
      </View>

      {/* Two labels, not thirty. The ends of the axis, and the summary the
          shape is evidence for. Never a number on every column. */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: t.textMuted, fontSize: 12 }}>{days.length} days ago</Text>
        <Text style={{ color: t.textMuted, fontSize: 12 }}>Today</Text>
      </View>
      <Body muted>
        {total} answer{total === 1 ? '' : 's'} across {studied} day{studied === 1 ? '' : 's'}.
      </Body>
    </Card>
  );
}

/** Where you stand, by the sections your notes are actually divided into. */
function Sections({ data }: { data: DashboardData }) {
  const { strong, weak, tooEarly } = data.sections;

  if (strong.length === 0 && weak.length === 0) {
    return (
      <Card>
        <Body>Where you stand</Body>
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
      <Body>Where you stand</Body>
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
            {/* The raw count, not just a percentage: "4 of 5" is checkable and
                carries its own sample size, which a bare 80% hides. */}
            <Text style={{ color: t.textMuted, fontSize: 13 }}>
              {s.correct} of {s.attempts}
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
 * How much room is left, mentioned only when it is nearly gone.
 *
 * The owner was explicit: *"don't show upfront everytime regarding their limit
 * … you can put it in the dashboard."* So this is the one place the number
 * lives, and it stays silent until `summariseUsage` says it is worth raising.
 * A quota bar on a screen about learning would make the app feel like a disk
 * utility.
 *
 * It names the way out as well as the problem, because the way out is not
 * obvious: freeing space keeps every card and every answer, and removes only
 * the original file.
 */
function Space({ data }: { data: DashboardData }) {
  if (!data.usage.worthMentioning) return null;

  return (
    <Card>
      <Body>Running low on space</Body>
      <Body muted>
        You're using {formatBytes(data.usage.usedBytes)} of your {formatBytes(MAX_USER_BYTES)}. On a
        set you've finished with, "Free up space" removes the original file and keeps all your
        cards and progress.
      </Body>
    </Card>
  );
}
