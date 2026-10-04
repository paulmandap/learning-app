import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Body, Button } from './components';
import { Sheet, SheetTitle } from './sheet';
import { Icon } from './glyphs';
import { TextLink } from './legal';
import { radius, space, useTheme } from './theme';
import { WHATS_NEW, whatsNewKey } from '../core/whats-new';

/**
 * What is new, once per person per device (NOTES §51).
 *
 * On this device rather than on the account, unlike the privacy notice (NOTES
 * §37): that one gates what is SENT to Google and has to be recorded; this one
 * only tells somebody something, and seeing it twice on a second phone costs a
 * tap. Storage that throws — a private window, cleared site data — means it
 * shows, which is the safe way round for a notice.
 *
 * A sheet over Home since §62 — the owner: *"it would be better if that will
 * appear in the background blur so that users will immediately see it. it's
 * cleaner that way."* It was a card among the others, which pushed Continue
 * down and was easy to scroll past. Tapping outside is "Got it" too.
 */
export function WhatsNewSheet({ userId }: { userId: string }) {
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

  // One button since §71: "Find friends" belonged to the sharing notice, and the
  // faster opening has nowhere to send anyone.
  return (
    <Sheet onClose={dismiss} footer={<Button label="Got it" onPress={dismiss} />}>
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.card,
        }}
      >
        <Icon name={WHATS_NEW.icon} color={t.accent} size={26} />
      </View>
      <SheetTitle>{WHATS_NEW.title}</SheetTitle>
      <Body>{WHATS_NEW.body}</Body>
      <Body muted>{WHATS_NEW.policy}</Body>
      <TextLink
        label="Read the Privacy Policy"
        onPress={() => {
          dismiss();
          router.push('/privacy');
        }}
      />
    </Sheet>
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
