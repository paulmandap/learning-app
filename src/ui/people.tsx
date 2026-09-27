import { useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Body, Button, Notice } from './components';
import { PersonAvatar } from './avatar';
import { elevation, INPUT_FONT_SIZE, radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import { GLYPH } from './glyphs';
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
}) {
  const t = useTheme();
  const shown = personName({ name, username });
  const handle = atUsername(username);
  const line = [handle !== shown ? handle : null, detail].filter(Boolean).join(' · ');

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        padding: space.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.card,
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
        <PersonAvatar avatar={avatar} userId={id} name={shown} size={40} />
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
        {onPress && !children ? (
          <Text style={{ color: t.textMuted, fontSize: 22 }}>{GLYPH.forward}</Text>
        ) : null}
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
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  busy?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={busy}
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
        opacity: pressed || busy ? 0.6 : 1,
      })}
    >
      <Text style={[type.label, { color: primary ? t.accentText : t.text, fontWeight: '600' }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * A sheet's heading. A title, not a `Label`: photographed at 393px, "Report
 * Probe B" in small grey type read as a caption over the list rather than as
 * what the whole sheet was for.
 */
function SheetTitle({ children }: { children: string }) {
  const t = useTheme();
  return (
    <Text style={[type.title, { color: t.text }]} accessibilityRole="header">
      {children}
    </Text>
  );
}

/** The sheet both of the below sit in — the same one the chat's message menu uses. */
function Sheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const t = useTheme();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={[
          {
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.55)',
            justifyContent: 'flex-end',
            zIndex: elevation.float + 1,
          },
          Platform.OS === 'web' ? ({ backdropFilter: 'blur(6px)' } as object) : null,
        ]}
      >
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: t.bg,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderTopWidth: 1,
            borderColor: t.border,
            maxHeight: '90%',
          }}
        >
          <ScrollView
            contentContainerStyle={{ padding: space.lg, gap: space.md }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
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
  onClose,
}: {
  kind: ReportKind;
  targetId: string;
  /** Whose it is, where there is a person — "Report Paul", "Block Paul". */
  name?: string;
  /** Offered after sending, when there is a person to block. */
  onBlock?: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
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

  return (
    <Sheet onClose={onClose}>
      <SheetTitle>{reportTitle(kind, name)}</SheetTitle>
      <Body muted>What is wrong with it?</Body>

      <View
        accessibilityRole="radiogroup"
        style={{ borderWidth: 1, borderColor: t.border, borderRadius: radius.md, overflow: 'hidden' }}
      >
        {reasonsFor(kind).map((r, i) => {
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
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: t.border,
                backgroundColor: chosen ? t.card : pressed ? t.card : 'transparent',
              })}
            >
              {/* A mark as well as a colour — never hue alone. */}
              <Text style={{ width: 18, color: t.accent, fontSize: 16 }}>{chosen ? GLYPH.right : ''}</Text>
              <Text style={[chosen ? type.bodyStrong : type.body, { color: t.text, flex: 1 }]}>{r.label}</Text>
            </Pressable>
          );
        })}
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

      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button label="Send report" onPress={send} busy={busy} />
      <Button label="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
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

  return (
    <Sheet onClose={onClose}>
      <SheetTitle>{`Block ${name}?`}</SheetTitle>
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
