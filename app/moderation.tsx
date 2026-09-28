import { useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, Chip, LoadingState, Notice, Screen, Title } from '../src/ui/components';
import { StatePanel } from '../src/ui/states';
import { PersonAvatar } from '../src/ui/avatar';
import { GLYPH } from '../src/ui/glyphs';
import { INPUT_FONT_SIZE, radius, space, TOUCH_TARGET, type, useTheme } from '../src/ui/theme';
import {
  dismissReports,
  isModerator,
  liftRestriction,
  listReportQueue,
  markReportsActioned,
  removeReported,
  restrictAccount,
  warnAccount,
  type QueuedReport,
} from '../src/data/moderation';
import { COMMUNITY_RULES, RESTRICT_OPTIONS } from '../src/core/rules';
import { REPORT_REASONS } from '../src/core/social';
import { describeWhen } from '../src/core/chat';
import { personName } from '../src/core/social';

/**
 * Reports to review — for the moderator alone (NOTES §55).
 *
 * The database decides who that is (`app_admins`, and `report_queue` filters by
 * `is_admin()` inside the view): anybody else who opens this address sees an
 * empty queue and a sentence, not a door.
 *
 * One card per reported THING, not per report: three people reporting one post
 * is one decision with "3 reports" on it, and deciding closes all three.
 */

const KIND_LABEL: Record<QueuedReport['target_kind'], string> = {
  person: 'A person',
  message: 'A message in the Everyone room',
  direct_message: 'A message to a friend',
  set: 'A shared set',
  post: 'A post',
  comment: 'A comment',
};

function reasonLabel(key: string): string {
  return REPORT_REASONS.find((r) => r.key === key)?.label ?? key;
}

export default function Moderation() {
  const t = useTheme();
  const queryClient = useQueryClient();
  const moderator = useQuery({ queryKey: ['is-moderator'], queryFn: () => isModerator() });
  const queue = useQuery({
    queryKey: ['report-queue'],
    queryFn: () => listReportQueue(),
    enabled: moderator.data === true,
  });

  // Newest report per thing, with every report on it gathered.
  const groups = useMemo(() => {
    const byTarget = new Map<string, QueuedReport[]>();
    for (const r of queue.data ?? []) {
      const key = `${r.target_kind}:${r.target_id}`;
      byTarget.set(key, [...(byTarget.get(key) ?? []), r]);
    }
    return [...byTarget.values()];
  }, [queue.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['report-queue'] });

  if (moderator.isLoading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (!moderator.data) {
    return (
      <Screen centered>
        <StatePanel kind="empty" title="Nothing here" detail="This page is for Nomi's moderator." />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Reports</Title>
      <Text style={[type.caption, { color: t.textMuted }]}>
        What you do here is between you and them: the person who reported is never named to anybody.
      </Text>
      {queue.isLoading ? <LoadingState /> : null}
      {queue.data && groups.length === 0 ? (
        <StatePanel kind="empty" title="Nothing to review" detail="Every report has been dealt with." />
      ) : null}
      {groups.map((reports) => (
        <ReportCard key={`${reports[0]!.target_kind}:${reports[0]!.target_id}`} reports={reports} onDone={refresh} />
      ))}
    </Screen>
  );
}

type Mode = 'idle' | 'warn' | 'restrict';

function ReportCard({ reports, onDone }: { reports: QueuedReport[]; onDone: () => void }) {
  const t = useTheme();
  const router = useRouter();
  const first = reports[0]!;
  const who = personName({ name: first.reported_name, username: first.reported_username });
  const [mode, setMode] = useState<Mode>('idle');
  const [rule, setRule] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const act = useMutation({
    mutationFn: async (what: () => Promise<void>) => what(),
    onSuccess: () => {
      setMode('idle');
      onDone();
    },
  });

  const restricted = first.restricted_for_good
    ? 'Restricted for good'
    : first.restricted_until && Date.parse(first.restricted_until) > Date.now()
      ? `Restricted until ${new Date(first.restricted_until).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`
      : null;

  const open = () => {
    if (first.target_kind === 'post') router.push(`/post/${first.target_id}`);
    else if (first.target_kind === 'set') router.push(`/set/${first.target_id}`);
    else if (first.reported_user_id) router.push(`/person/${first.reported_user_id}`);
  };

  const kind = first.target_kind;
  const target = first.target_id;
  const user = first.reported_user_id;

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        <Text style={[type.bodyStrong, { color: t.text, flex: 1 }]}>{KIND_LABEL[kind]}</Text>
        {reports.length > 1 ? <Chip tone="accent">{`${reports.length} reports`}</Chip> : null}
        <Text style={[type.caption, { color: t.textMuted }]}>{describeWhen(Date.parse(first.created_at), Date.now())}</Text>
      </View>

      {/* Who it is about — their page, from here. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${who}'s profile`}
        onPress={() => user && router.push(`/person/${user}`)}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.sm, opacity: pressed ? 0.7 : 1 })}
      >
        <PersonAvatar avatar={first.reported_avatar} userId={user ?? first.id} name={who} size={32} />
        <View style={{ flex: 1 }}>
          <Text style={[type.body, { color: t.text }]}>{who}</Text>
          {restricted ? <Text style={[type.caption, { color: t.danger }]}>{restricted}</Text> : null}
        </View>
      </Pressable>

      {/* What was reported, as the database copied it when it was. */}
      {first.snapshot ? (
        <View style={{ borderLeftWidth: 3, borderLeftColor: t.border, paddingLeft: space.md }}>
          <Text style={[type.body, { color: t.text }]} selectable>
            {first.snapshot}
          </Text>
        </View>
      ) : null}

      {reports.map((r) => (
        <Text key={r.id} style={[type.caption, { color: t.textMuted }]}>
          {reasonLabel(r.reason)}
          {r.details ? ` — "${r.details}"` : ''}
          {` · from ${personName({ name: r.reporter_name, username: r.reporter_username })}`}
        </Text>
      ))}

      {act.isError ? <Notice tone="error">{(act.error as Error).message}</Notice> : null}

      {mode === 'idle' ? (
        <View style={{ gap: space.sm }}>
          {kind !== 'person' ? (
            <Button
              label={kind === 'set' ? 'Unshare the set' : 'Remove it'}
              variant="danger"
              onPress={() => act.mutate(() => removeReported(kind, target))}
              busy={act.isPending}
            />
          ) : null}
          {user ? <Button label={`Warn ${who}`} variant="secondary" onPress={() => setMode('warn')} /> : null}
          {user ? <Button label={`Restrict ${who}`} variant="secondary" onPress={() => setMode('restrict')} /> : null}
          {user && restricted ? (
            <Button
              label="Lift the restriction"
              variant="secondary"
              onPress={() => act.mutate(() => liftRestriction(user))}
              disabled={act.isPending}
            />
          ) : null}
          <Button
            label="Dismiss — nothing wrong"
            variant="secondary"
            onPress={() => act.mutate(() => dismissReports(kind, target))}
            disabled={act.isPending}
          />
          {kind === 'post' || kind === 'set' || kind === 'person' ? (
            <Pressable accessibilityRole="button" onPress={open} style={{ minHeight: TOUCH_TARGET, justifyContent: 'center' }}>
              <Text style={[type.label, { color: t.accent }]}>{`Open it ${GLYPH.forward}`}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {mode === 'warn' && user ? (
        <View style={{ gap: space.sm }}>
          <Body>Which rule did they break?</Body>
          <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: radius.md, overflow: 'hidden' }}>
            {COMMUNITY_RULES.map((r, i) => (
              <Pressable
                key={r.key}
                accessibilityRole="radio"
                accessibilityState={{ checked: rule === r.key }}
                accessibilityLabel={r.title}
                onPress={() => setRule(r.key)}
                style={{
                  flexDirection: 'row',
                  gap: space.md,
                  minHeight: TOUCH_TARGET,
                  alignItems: 'center',
                  paddingHorizontal: space.md,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: t.border,
                  backgroundColor: rule === r.key ? t.bg : 'transparent',
                }}
              >
                <Text style={{ width: 16, color: t.accent }}>{rule === r.key ? GLYPH.right : ''}</Text>
                <Text style={[rule === r.key ? type.bodyStrong : type.body, { color: t.text }]}>{r.title}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="A note for them (optional)"
            placeholderTextColor={t.textMuted}
            multiline
            maxLength={500}
            style={{
              minHeight: 64,
              padding: space.md,
              borderWidth: 1,
              borderColor: t.border,
              borderRadius: radius.sm,
              color: t.text,
              backgroundColor: t.bg,
              fontSize: INPUT_FONT_SIZE,
              textAlignVertical: 'top',
            }}
          />
          <Button
            label="Send the warning"
            onPress={() =>
              rule &&
              act.mutate(async () => {
                await warnAccount(user, rule, note);
                await markReportsActioned(kind, target);
              })
            }
            disabled={!rule}
            busy={act.isPending}
          />
          <Button label="Cancel" variant="secondary" onPress={() => setMode('idle')} disabled={act.isPending} />
        </View>
      ) : null}

      {mode === 'restrict' && user ? (
        <View style={{ gap: space.sm }}>
          <Body>{`${who} will still be able to study, but not post, comment, message, add friends or share sets.`}</Body>
          {RESTRICT_OPTIONS.map((o) => (
            <Button
              key={o.label}
              label={`Restrict ${o.label}`}
              variant={o.days === null ? 'danger' : 'secondary'}
              onPress={() =>
                act.mutate(async () => {
                  await restrictAccount(user, o.days, first.reason);
                  await markReportsActioned(kind, target);
                })
              }
              disabled={act.isPending}
            />
          ))}
          <Button label="Cancel" variant="secondary" onPress={() => setMode('idle')} disabled={act.isPending} />
        </View>
      ) : null}
    </Card>
  );
}
