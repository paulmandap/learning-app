import { useRouter } from 'expo-router';
import { LegalScreen } from '../src/ui/legal';
import { TERMS_OF_USE } from '../src/core/legal';

/** Terms of Use (NOTES §40). Open to anyone, signed in or not. */
export default function Terms() {
  const router = useRouter();
  return (
    <LegalScreen
      doc={TERMS_OF_USE}
      related={{ label: 'Read the Privacy Policy', onPress: () => router.push('/privacy') }}
    />
  );
}
