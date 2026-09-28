import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Body, Card, LoadingState, Notice, Screen, TopBar } from '../src/ui/components';
import { StatePanel } from '../src/ui/states';
import { PostList } from '../src/ui/post';
import { listSaved, SAVED_LIMIT, SavesUnavailableError } from '../src/data/posts';
import { useSessionStore } from '../src/data/session';

/**
 * The posts you saved (NOTES §57, migration 0031), most recently saved first.
 *
 * Private: nobody else, the post's author included, can see that you saved
 * one. A post you can no longer see — deleted, made friends-only, an
 * unfriending or a block — leaves this list with it, because the list reads
 * posts through `feed_posts`, the same rule as the feed.
 *
 * A screen of its own for now, from the bookmark at the top of Profile. The
 * owner chose a Saved tab on Profile, which step four builds; this list is
 * what that tab will show.
 */
export default function Saved() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const myId = useSessionStore((s) => s.session?.user.id ?? '');
  const saved = useQuery({
    queryKey: ['saved'],
    queryFn: () => listSaved(),
    retry: (count, err) => !(err instanceof SavesUnavailableError) && count < 1,
  });
  const posts = saved.data ?? [];

  return (
    <Screen>
      <TopBar title="Saved" />
      <Body muted>Only you can see what you save.</Body>
      {saved.isLoading ? <LoadingState /> : null}
      {saved.error instanceof SavesUnavailableError ? (
        <Card>
          <Body>Saving posts isn&apos;t switched on yet.</Body>
          <Body muted>Nothing is missing from your account — this part of the app just needs to be set up.</Body>
        </Card>
      ) : null}
      {saved.error && !(saved.error instanceof SavesUnavailableError) ? (
        <Notice tone="error">Couldn&apos;t load what you saved. Try again in a moment.</Notice>
      ) : null}
      {saved.data && posts.length === 0 ? (
        <StatePanel
          kind="empty"
          title="Nothing saved yet"
          detail="Tap the bookmark under a post to keep it here."
          action={{ label: 'Go to the feed', onPress: () => router.push('/community') }}
        />
      ) : null}
      <PostList
        posts={posts}
        myId={myId}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ['saved'] })}
      />
      {posts.length >= SAVED_LIMIT ? <Body muted>{`Showing the ${SAVED_LIMIT} you saved most recently.`}</Body> : null}
    </Screen>
  );
}
