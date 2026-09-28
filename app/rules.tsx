import { useRouter } from 'expo-router';
import { Body, Screen, Title } from '../src/ui/components';
import { RulesList } from '../src/ui/rules';
import { TextLink } from '../src/ui/legal';
import { RULES_CONSEQUENCES } from '../src/core/rules';

/**
 * The community rules, to read (NOTES §55). Readable signed out, like the Terms
 * and the Privacy Policy — somebody deciding whether to join can read how
 * people are expected to treat each other there.
 */
export default function Rules() {
  const router = useRouter();
  return (
    <Screen>
      <Title>Community rules</Title>
      <Body muted>How to treat each other on Nomi. Everybody agrees to these before they post, message or add friends.</Body>
      <RulesList />
      <Body muted>{RULES_CONSEQUENCES}</Body>
      <TextLink label="Terms of Use" onPress={() => router.push('/terms')} />
    </Screen>
  );
}
