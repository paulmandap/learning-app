import { useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import { useSegments } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from './components';
import { CONTENT_MAX_WIDTH, radius, space, type, useTheme } from './theme';
import { acceptPrivacy, fetchProfile, hasAcceptedPrivacy } from '../data/profile';
import { useSessionStore } from '../data/session';

/**
 * Where your notes go — D13's approved words, read once (NOTES §37).
 *
 * ## Why it left Settings
 *
 * It was the second card on Settings, three paragraphs long, above the key. The
 * owner asked for it to go, and asked whether a privacy policy at sign-up would
 * be cleaner. The answer given: a short notice shown once, yes; a long terms
 * document people accept without reading, no — D13 exists so that one sentence
 * is actually read, "a real person at Google may read them", and a long
 * document hides exactly that sentence. He chose the short notice, once, with
 * a Privacy link in Settings to read it again.
 *
 * ## The words are not paraphrased
 *
 * D13 says to use these words and not to paraphrase them smaller, and they were
 * extended with the owner's approval when the assistant began sending what it
 * knows about the student (NOTES §36). They moved; they did not change.
 * `tests/screens.test.ts` pins them between the markers below, and the
 * companion's name stays out of that block — comments included.
 */
export function PrivacyCopy() {
  const t = useTheme();
  const paragraph = [type.body, { color: t.text }];
  return (
    <View style={{ gap: space.md }}>
      {/* PRIVACY COPY START */}
      <Text style={paragraph}>
        When you make cards, your notes are sent to Google using your own free key. The key is
        free, so Google may keep your notes to help improve its products — and a real person at
        Google may read them.
      </Text>
      <Text style={paragraph}>
        Please don't add patient information, anyone's personal details, or confidential work
        documents. A good test: if you wouldn't want a stranger reading it, don't put it here.
      </Text>
      <Text style={paragraph}>
        The study assistant works the same way — what you ask it, the notes it looks at, and
        what it knows about your studying (your name, sets, streak and progress) are sent to
        Google too.
      </Text>
      {/* PRIVACY COPY END */}
    </View>
  );
}

/**
 * The notice itself: over everything the first time, from Settings after that.
 *
 * The first time it has no close control and no tap-away, only "I understand" —
 * the point is that it is read before anything is sent. Reopened from Settings
 * it is just something to read, with Close.
 */
export function PrivacyNotice({
  visible,
  firstTime = false,
  onAccept,
  onClose,
  busy,
  error,
}: {
  visible: boolean;
  firstTime?: boolean;
  onAccept?: () => void;
  onClose?: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!firstTime) onClose?.();
      }}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: space.lg,
          paddingTop: insets.top + space.lg,
          paddingBottom: insets.bottom + space.lg,
        }}
      >
        <View
          style={{
            width: '100%',
            maxWidth: CONTENT_MAX_WIDTH,
            maxHeight: '100%',
            backgroundColor: t.card,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: t.border,
            padding: space.lg,
            gap: space.md,
          }}
        >
          {firstTime ? <Text style={[type.label, { color: t.textMuted }]}>Before you start</Text> : null}
          <Text accessibilityRole="header" style={[type.title, { color: t.text }]}>
            Where your notes go
          </Text>
          <ScrollView style={{ flexShrink: 1 }}>
            <PrivacyCopy />
          </ScrollView>
          {error ? <Text style={[type.body, { color: t.danger }]}>{error}</Text> : null}
          {firstTime ? (
            <Button label="I understand" onPress={() => onAccept?.()} busy={busy} />
          ) : (
            <Button label="Close" variant="secondary" onPress={() => onClose?.()} />
          )}
        </View>
      </View>
    </Modal>
  );
}

/**
 * Shows the notice once, to anyone signed in who has not accepted it.
 *
 * Mounted once at the root, so it is the same on every screen someone lands on
 * first — Home, a deep link into a set, the installed app reopened. Waits for
 * the profile before deciding, so nobody who has already accepted sees it flash.
 */
export function PrivacyGate() {
  const session = useSessionStore((s) => s.session);
  const segments = useSegments();
  const client = useQueryClient();
  const userId = session?.user.id ?? '';

  const { data: profile, isSuccess } = useQuery({
    queryKey: ['profile'],
    queryFn: fetchProfile,
    enabled: !!session,
  });

  const [acceptedNow, setAcceptedNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show =
    !!session &&
    segments[0] !== 'sign-in' &&
    isSuccess &&
    !acceptedNow &&
    !hasAcceptedPrivacy(profile, userId);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await acceptPrivacy();
      setAcceptedNow(true);
      await client.invalidateQueries({ queryKey: ['profile'] });
    } catch (err) {
      console.warn(`[privacy] could not record the notice: ${err instanceof Error ? err.message : String(err)}`);
      setError("Couldn't save that just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return <PrivacyNotice visible={show} firstTime onAccept={() => void accept()} busy={busy} error={error} />;
}
