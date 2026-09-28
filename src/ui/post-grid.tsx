import { useMemo } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Icon } from './glyphs';
import { petFrame } from './pet';
import { radius, space, type, useTheme } from './theme';
import { POST_IMAGE_LINK_SECONDS, type FeedPost } from '../core/posts';
import { petStage, toPetSpecies } from '../core/pet';
import { postImageUrls } from '../data/posts';

/**
 * Posts as a grid of squares, three across — a profile's Posts tab (NOTES
 * §59, the owner's picture). A photo fills its square; a shared set is its
 * icon and title; a streak is the pet and the days; words are the first few
 * lines. Every square opens the post.
 *
 * The same posts `PostList` shows, read through the same rule; only the
 * drawing differs, because a profile is somewhere to see what somebody posts
 * at a glance, and the feed is somewhere to read it.
 */
export function PostGrid({ posts }: { posts: readonly FeedPost[] }) {
  const router = useRouter();
  const paths = useMemo(() => posts.map((p) => p.image_path).filter((p): p is string => !!p), [posts]);
  const { data: links = {} } = useQuery({
    queryKey: ['post-images', paths],
    queryFn: () => postImageUrls(paths),
    enabled: paths.length > 0,
    staleTime: (POST_IMAGE_LINK_SECONDS - 120) * 1000,
  });

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -space.hair }}>
      {posts.map((post) => (
        <View key={post.id} style={{ width: '33.333%', aspectRatio: 1, padding: space.hair }}>
          <Tile
            post={post}
            imageUrl={post.image_path ? (links[post.image_path] ?? null) : null}
            onPress={() => router.push(`/post/${post.id}`)}
          />
        </View>
      ))}
    </View>
  );
}

function Tile({ post, imageUrl, onPress }: { post: FeedPost; imageUrl: string | null; onPress: () => void }) {
  const t = useTheme();
  const what = post.image_path
    ? 'A photo'
    : post.set_id
      ? `A set, ${post.set_title ?? 'no longer shared'}`
      : post.streak_days
        ? `A ${post.streak_days}-day streak`
        : 'Words';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Post. ${what}${post.body ? `: ${post.body.slice(0, 80)}` : ''}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        borderRadius: radius.sm,
        overflow: 'hidden',
        backgroundColor: t.card,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {post.image_path ? (
        imageUrl ? (
          <Image source={{ uri: imageUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        ) : null
      ) : post.set_id ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.xs, padding: space.sm }}>
          <Icon name="set" color={t.accent} size={24} />
          <Text style={[type.caption, { color: t.text, textAlign: 'center' }]} numberOfLines={2}>
            {post.set_title ?? 'Not shared any more'}
          </Text>
          <Text style={[type.caption, { color: t.textMuted, fontSize: 11 }]}>{`${post.set_cards} cards`}</Text>
        </View>
      ) : post.streak_days ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 }}>
          <Image
            source={petFrame(toPetSpecies(post.pet), petStage(post.streak_days)?.index ?? 0)}
            style={{ width: '55%', height: '55%' }}
            resizeMode="contain"
          />
          <Text style={[type.bodyStrong, { color: t.text }]}>{`${post.streak_days} days`}</Text>
        </View>
      ) : (
        <View style={{ flex: 1, padding: space.sm, justifyContent: 'center' }}>
          <Text style={[type.caption, { color: t.text }]} numberOfLines={5}>
            {post.body}
          </Text>
        </View>
      )}
    </Pressable>
  );
}
