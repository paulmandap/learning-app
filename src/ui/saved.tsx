import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { Body, Card, LoadingState, Notice } from './components';
import { StatePanel } from './states';
import { PostList } from './post';
import { space } from './theme';
import { listSaved, SAVED_LIMIT, SavesUnavailableError } from '../data/posts';

/**
 * The posts you saved (NOTES §57, migration 0031), most recently saved first —
 * Profile's Saved tab since §59, where the owner chose to have it. It was a
 * screen of its own from a bookmark in Profile's top bar until then.
 *
 * Private: nobody else, the post's author included, can see that you saved
 * one. A post you can no longer see — deleted, made friends-only, an
 * unfriending or a block — leaves this list with it, because the list reads
 * posts through `feed_posts`, the same rule as the feed.
 */
export function SavedPosts({ myId }: { myId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const saved = useQuery({
    queryKey: ['saved'],
    queryFn: () => listSaved(),
    retry: (count, err) => !(err instanceof SavesUnavailableError) && count < 1,
  });
  const posts = saved.data ?? [];

  return (
    <View style={{ gap: space.md }}>
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
      <PostList posts={posts} myId={myId} onChanged={() => queryClient.invalidateQueries({ queryKey: ['saved'] })} />
      {posts.length >= SAVED_LIMIT ? <Body muted>{`Showing the ${SAVED_LIMIT} you saved most recently.`}</Body> : null}
    </View>
  );
}
