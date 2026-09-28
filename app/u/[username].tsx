import { useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { LoadingState, Screen } from '../../src/ui/components';
import { StatePanel } from '../../src/ui/states';
import { personByUsername } from '../../src/data/social';
import { useSessionStore } from '../../src/data/session';

/**
 * A shared profile link — nomi's address /u/<username> (NOTES §59, Share
 * profile). Finds who has that username and opens their page, or your own
 * Profile if it is you.
 *
 * Signed out, the app's sign-in comes first, as for every page but the legal
 * ones; the link grants nothing. Somebody across a block from you is "not
 * found", the same answer as nobody at all — as on their page.
 */
export default function ProfileLink() {
  const router = useRouter();
  const { username } = useLocalSearchParams<{ username: string }>();
  const me = useSessionStore((s) => s.session?.user.id ?? '');
  const found = useQuery({ queryKey: ['person-by-username', username], queryFn: () => personByUsername(String(username)) });

  useEffect(() => {
    if (!found.data) return;
    router.replace(found.data === me ? '/profile' : `/person/${found.data}`);
  }, [found.data, me, router]);

  if (found.isLoading || found.data) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }
  return (
    <Screen centered>
      <StatePanel
        kind="empty"
        title="We couldn't find this person"
        detail="The link may be old — usernames can change."
        action={{ label: 'Go to Nomi', onPress: () => router.replace('/') }}
      />
    </Screen>
  );
}
