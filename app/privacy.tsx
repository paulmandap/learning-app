import { useRouter } from 'expo-router';
import { LegalScreen } from '../src/ui/legal';
import { PRIVACY_POLICY } from '../src/core/legal';

/**
 * Privacy Policy (NOTES §40). Open to anyone, signed in or not.
 *
 * The full document. "Privacy: where your notes go" in Settings is still D13's
 * short notice, shown once after signing in — the policy does not replace it.
 */
export default function Privacy() {
  const router = useRouter();
  return (
    <LegalScreen
      doc={PRIVACY_POLICY}
      related={{ label: 'Read the Terms of Use', onPress: () => router.push('/terms') }}
    />
  );
}
