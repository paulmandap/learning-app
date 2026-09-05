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
 * ## Four blocks, and nothing else
 *
 * The brief was explicit: *"don't make the dashboard tab become too much info.
 * Keep it simple."* Everything that did not answer one of those two questions
 * was left out — no accuracy graph, no per-day chart, no totals for their own
 * sake. Four blocks: how you are going, what has stuck, where you stand, and
 * one thing to do next.
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
 * What has stuck: one bar, four numbers.
 *
 * A bar rather than only counts, for the same reason the study progress bar
 * exists: seeing the green section grow across weeks is the part that motivates,
 * and four bare numbers do not show growth.
 */
function Mastery({ data }: { data: DashboardData }) {
  const t = useTheme();
  const { mastered, learning, struggling } = data.mastery;
  const fresh = data.mastery.new;
  const total = mastered + learning + struggling + fresh;
  if (total === 0) return null;

  const segments = [
    { key: 'mastered', label: 'Known well', n: mastered, color: t.ok },
    { key: 'learning', label: 'Getting there', n: learning, color: t.accent },
    { key: 'struggling', label: 'Tricky', n: struggling, color: t.warnText },
    { key: 'new', label: 'Not started', n: fresh, color: t.border },
  ].filter((s) => s.n > 0);

  return (
    <Card>
      <Body>What has stuck</Body>

      <View
        style={{
          flexDirection: 'row',
          height: 12,
          borderRadius: radius.sm,
          overflow: 'hidden',
          backgroundColor: t.bg,
        }}
      >
        {segments.map((s) => (
          <View key={s.key} style={{ flex: s.n, backgroundColor: s.color }} />
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
        <View
          key={s.section}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            borderLeftWidth: 3,
            borderLeftColor: color,
            paddingLeft: space.sm,
            paddingVertical: 2,
          }}
        >
          <Text style={{ color: t.text, fontSize: 15, flex: 1 }} numberOfLines={2}>
            {s.section}
          </Text>
          {/* The raw count, not just a percentage: "4 of 5" is checkable and
              carries its own sample size, which a bare 80% hides. */}
          <Text style={{ color: t.textMuted, fontSize: 13 }}>
            {s.correct} of {s.attempts}
          </Text>
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
