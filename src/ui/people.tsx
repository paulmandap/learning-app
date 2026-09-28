import { useState, type ReactNode } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { TextLink } from './legal';
import { Body, Button, Notice, Rows } from './components';
import { PersonAvatar } from './avatar';
import { Sheet, SheetTitle } from './sheet';
import { INPUT_FONT_SIZE, radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import { Icon } from './glyphs';
import {
  atUsername,
  blockFacts,
  personName,
  reasonsFor,
  reportTitle,
  REPORT_DETAILS_MAX,
  REPORT_SENT,
  type ReportKind,
  type ReportReason,
} from '../core/social';
import { blockPerson, reportContent } from '../data/social';

/**
 * People, and the two ways to stop one (NOTES §51).
 *
 * Shared by the Profile tab, a person's page, the chat and a shared set — every
 * place one person meets another. Blocking and reporting in particular are
 * written ONCE: a report sheet on the chat that said something different from
 * the one on a person's page would be two promises about the same thing.
 */

/**
 * One person in a list: their picture, their name, their @username.
 *
 * Not `ListRow`, for the reason `SharedSetRow` is not: some of these carry
 * controls (Accept, Decline, Unblock), and a control inside a row that is itself
 * a button needs the two touch targets kept apart, or accepting a request opens
 * the person instead.
 */
export function PersonRow({
  id,
  name,
  username,
  avatar,
  detail,
  onPress,
  children,
  inset,
}: {
  id: string;
  name: string | null;
  username: string | null;
  avatar: string | null;
  /** A short line under the name — "Friends", "Asked to be friends". */
  detail?: string;
  onPress?: () => void;
  /** Controls at the far end of the row. */
  children?: ReactNode;
  /** Padded at the sides, for a row on a card (`Rows card`) or in a sheet. */
  inset?: boolean;
}) {
  const t = useTheme();
  const shown = personName({ name, username });
  const handle = atUsername(username);
  const line = [handle !== shown ? handle : null, detail].filter(Boolean).join(' · ');

  // A row among rows since the redesign (NOTES §59): no box of its own — the
  // list around it draws the hairlines (`Rows`), the way the owner's picture
  // lists people.
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingVertical: space.sm,
        paddingHorizontal: inset ? space.lg : 0,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${shown}${handle && handle !== shown ? `, ${handle}` : ''}${detail ? `. ${detail}` : ''}`}
        onPress={onPress}
        disabled={!onPress}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          minHeight: TOUCH_TARGET,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <PersonAvatar avatar={avatar} userId={id} name={shown} size={44} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>
            {shown}
          </Text>
          {line ? (
            <Text style={[type.caption, { color: t.textMuted }]} numberOfLines={1}>
              {line}
            </Text>
          ) : null}
        </View>
        {onPress && !children ? <Icon name="forward" color={t.textMuted} size={20} /> : null}
      </Pressable>
      {children ? <View style={{ flexDirection: 'row', gap: space.xs }}>{children}</View> : null}
    </View>
  );
}

/**
 * A small button for inside a row — Accept, Decline, Cancel, Unblock.
 *
 * Not `Button`, which is full width by design (one column, one width — see its
 * note in components.tsx). Not `PillButton` either: that one is "there is
 * something here if you want it" in a heading, and this is an answer to a
 * question the row is asking.
 */
export function RowButton({
  label,
  onPress,
  primary,
  busy,
  disabled,
  shown,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  busy?: boolean;
  /** Nothing to do yet — Post with nothing written. Dimmed further than busy. */
  disabled?: boolean;
  /** The word on the button, where a list of them needs the label to say which — "Send", "Send to Maria". */
  shown?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!busy }}
      onPress={onPress}
      disabled={busy || disabled}
      hitSlop={4}
      style={({ pressed }) => ({
        minHeight: 36,
        minWidth: 44,
        paddingHorizontal: space.md,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: primary ? t.accent : t.border,
        backgroundColor: primary ? t.accent : 'transparent',
        opacity: disabled ? 0.45 : pressed || busy ? 0.6 : 1,
      })}
    >
      <Text style={[type.label, { color: primary ? t.accentText : t.text, fontWeight: '600' }]}>{shown ?? label}</Text>
    </Pressable>
  );
}

/**
 * Report a person, a message or a shared set.
 *
 * A reason is required and anything else is optional, because the reason is
 * what lets somebody reading a pile of reports see which ones are urgent, and a
 * required essay is how a report never gets sent.
 *
 * When it has gone, the person is told who reads it and that they will not be
 * named — and offered the block, because somebody reporting a person is very
 * often somebody who would also like not to see them again, and asking them to
 * find a second menu for it is asking a lot at that moment.
 */
export function ReportSheet({
  kind,
  targetId,
  name,
  onBlock,
  onSent,
  onClose,
}: {
  kind: ReportKind;
  targetId: string;
  /** Whose it is, where there is a person — "Report Paul", "Block Paul". */
  name?: string;
  /** Offered after sending, when there is a person to block. */
  onBlock?: () => void;
  /** Once it has gone — a reported post folds away for the reporter (NOTES §62). */
  onSent?: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const router = useRouter();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function send() {
    if (!reason) {
      setError('Pick what is wrong first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await reportContent(kind, targetId, reason, details);
      setSent(true);
      onSent?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Sheet onClose={onClose}>
        <SheetTitle>Report sent</SheetTitle>
        <Body>{REPORT_SENT}</Body>
        {onBlock && name ? (
          <Button label={`Block ${name}`} variant="secondary" onPress={onBlock} />
        ) : null}
        <Button label="Done" onPress={onClose} />
      </Sheet>
    );
  }

  // Send stays at the bottom whatever is scrolled (NOTES §60), as the rules'
  // "I agree" does: a reason, a box and a link had pushed it off a phone.
  return (
    <Sheet
      onClose={onClose}
      footer={
        <>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Button label="Send report" onPress={send} busy={busy} />
          <Button label="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
        </>
      }
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Icon name="report" color={t.danger} size={24} />
        <View style={{ flex: 1 }}>
          <SheetTitle>{reportTitle(kind, name)}</SheetTitle>
        </View>
      </View>
      <Body muted>What is wrong with it?</Body>

      <View accessibilityRole="radiogroup">
        <Rows card>
          {reasonsFor(kind).map((r) => {
            const chosen = reason === r.key;
            return (
              <Pressable
                key={r.key}
                accessibilityRole="radio"
                accessibilityState={{ checked: chosen }}
                accessibilityLabel={r.label}
                onPress={() => {
                  setReason(r.key);
                  setError(null);
                }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.md,
                  minHeight: TOUCH_TARGET,
                  paddingHorizontal: space.lg,
                  paddingVertical: space.sm,
                  backgroundColor: pressed ? t.bg : 'transparent',
                })}
              >
                <Text style={[chosen ? type.bodyStrong : type.body, { color: t.text, flex: 1 }]}>{r.label}</Text>
                {/* A mark as well as the weight — never one signal alone. */}
                <View style={{ width: 20 }}>{chosen ? <Icon name="check" color={t.accent} size={20} /> : null}</View>
              </Pressable>
            );
          })}
        </Rows>
      </View>

      <View style={{ gap: 6 }}>
        <Text style={[type.label, { color: t.textMuted }]}>Anything else? (optional)</Text>
        <TextInput
          value={details}
          onChangeText={setDetails}
          placeholder="What happened"
          placeholderTextColor={t.textMuted}
          multiline
          maxLength={REPORT_DETAILS_MAX}
          style={{
            minHeight: 72,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: radius.sm,
            padding: space.md,
            // Never under 16, or iOS zooms the page and stays zoomed.
            fontSize: INPUT_FONT_SIZE,
            color: t.text,
            backgroundColor: t.bg,
            textAlignVertical: 'top',
          }}
        />
      </View>

      {/* What counts as breaking the rules, one tap away (NOTES §55). */}
      <TextLink
        label="Read the community rules"
        onPress={() => {
          onClose();
          router.push('/rules');
        }}
      />
    </Sheet>
  );
}

/**
 * Block somebody — after saying what it does.
 *
 * The facts come from `blockFacts`, held to migration 0026 by
 * tests/social.test.ts, for the same reason `SHARING_FACTS` are: the only thing
 * that makes this a decision rather than a switch is knowing exactly what
 * happens, and a promise about it with nothing checking it is a wish.
 *
 * Everything cached is refreshed afterwards, not just the friends list. A block
 * changes the chat, the reactions, the shared sets, the due counts and search at
 * once, and a screen still showing the person you just blocked is the one thing
 * this must not do.
 */
export function BlockSheet({
  personId,
  name,
  onBlocked,
  onClose,
}: {
  personId: string;
  name: string;
  onBlocked?: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function block() {
    setBusy(true);
    setError(null);
    try {
      await blockPerson(personId);
      await queryClient.invalidateQueries();
      onBlocked?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't block them just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  const t = useTheme();
  return (
    <Sheet onClose={onClose}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Icon name="block" color={t.danger} size={24} />
        <View style={{ flex: 1 }}>
          <SheetTitle>{`Block ${name}?`}</SheetTitle>
        </View>
      </View>
      {blockFacts(name).map((fact) => (
        <Body key={fact} muted>
          {fact}
        </Body>
      ))}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button label={`Block ${name}`} variant="danger" onPress={block} busy={busy} />
      <Button label="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
    </Sheet>
  );
}
