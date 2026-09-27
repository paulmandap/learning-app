import { useState } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { Body, Button, Card } from './components';
import { TextLink } from './legal';
import { type, useTheme } from './theme';
import { WHATS_NEW, whatsNewKey } from '../core/whats-new';

/**
 * "New: friends", once per person per device (NOTES §51).
 *
 * On this device rather than on the account, unlike the privacy notice (NOTES
 * §37): that one gates what is SENT to Google and has to be recorded; this one
 * only tells somebody something, and seeing it twice on a second phone costs a
 * tap. Storage that throws — a private window, cleared site data — means it
 * shows, which is the safe way round for a notice.
 *
 * A card among the others rather than a sheet over them: nothing is blocked
 * until it is read, and Continue keeps the screen's one filled button.
 */
export function WhatsNewCard({ userId }: { userId: string }) {
  const t = useTheme();
  const router = useRouter();
  // Read on every render rather than once: Home renders before the session has
  // a user id, and a value computed then would be about nobody.
  const [dismissed, setDismissed] = useState(false);
  if (!userId || dismissed || readSeen(userId)) return null;

  const dismiss = () => {
    writeSeen(userId);
    setDismissed(true);
  };

  return (
    <Card>
      <Text style={[type.bodyStrong, { color: t.text }]} accessibilityRole="header">
        {WHATS_NEW.title}
      </Text>
      <Body>{WHATS_NEW.body}</Body>
      <Body muted>{WHATS_NEW.policy}</Body>
      <TextLink
        label="Read the Privacy Policy"
        onPress={() => {
          dismiss();
          router.push('/privacy');
        }}
      />
      <Button
        label="Find friends"
        variant="outline"
        onPress={() => {
          dismiss();
          router.push('/profile');
        }}
      />
      <Button label="Got it" variant="secondary" onPress={dismiss} />
    </Card>
  );
}

function readSeen(userId: string): boolean {
  try {
    return !!globalThis.localStorage?.getItem(whatsNewKey(userId));
  } catch {
    return false;
  }
}

function writeSeen(userId: string): void {
  try {
    globalThis.localStorage?.setItem(whatsNewKey(userId), new Date().toISOString());
  } catch {
    // Not remembered: it shows again next time, which is harmless.
  }
}
