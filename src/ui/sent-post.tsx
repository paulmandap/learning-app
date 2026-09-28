import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { PersonAvatar } from './avatar';
import { PostPhoto } from './post';
import { Icon } from './glyphs';
import { radius, space, type, useTheme } from './theme';
import { POST_IMAGE_LINK_SECONDS, type FeedPost } from '../core/posts';
import { personName } from '../core/social';
import { postImageUrls } from '../data/posts';

/**
 * A post, inside a message (NOTES §62): who wrote it, the start of what it
 * says, and what it carries — tap it for the whole post.
 *
 * Only ever drawn for a post the reader may see: the chat asks `feed_posts`,
 * and a message whose post the reader may not see is not shown to them at all
 * (the owner: no "This post isn't available" anywhere — it looks messy).
 */
export function SentPostCard({ post, openable = true }: { post: FeedPost; /** False in the composer, which is already about it. */ openable?: boolean }) {
  const t = useTheme();
  const router = useRouter();
  const name = personName({ name: post.author_name, username: post.author_username });
  const { data: links = {} } = useQuery({
    queryKey: ['post-images', [post.image_path]],
    queryFn: () => postImageUrls([post.image_path!]),
    enabled: !!post.image_path,
    staleTime: (POST_IMAGE_LINK_SECONDS - 120) * 1000,
  });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`A post by ${name}${post.body ? `: ${post.body.slice(0, 100)}` : ''}${openable ? '. Open it.' : ''}`}
      onPress={openable ? () => router.push(`/post/${post.id}`) : undefined}
      disabled={!openable}
      style={({ pressed }) => ({
        marginTop: space.xs,
        width: 240,
        maxWidth: '100%',
        gap: space.sm,
        padding: space.sm,
        borderRadius: radius.md,
        backgroundColor: t.bg,
        borderWidth: 1,
        borderColor: t.border,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <PersonAvatar avatar={post.author_avatar} userId={post.author_id} name={name} size={24} />
        <Text style={[type.label, { color: t.text, fontWeight: '700', flex: 1 }]} numberOfLines={1}>
          {name}
        </Text>
      </View>
      {post.body ? (
        <Text style={[type.caption, { color: t.text }]} numberOfLines={3}>
          {post.body}
        </Text>
      ) : null}
      {post.image_path ? (
        <PostPhoto uri={links[post.image_path] ?? null} width={post.image_width ?? 4} height={post.image_height ?? 3} />
      ) : post.set_id && post.set_title ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Icon name="set" color={t.accent} size={18} />
          <Text style={[type.caption, { color: t.text, flex: 1 }]} numberOfLines={1}>
            {`${post.set_title} — ${post.set_cards} card${post.set_cards === 1 ? '' : 's'}`}
          </Text>
        </View>
      ) : post.streak_days ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Icon name="streak" color={t.chart.tricky} size={18} />
          <Text style={[type.caption, { color: t.text }]}>{`${post.streak_days} day${post.streak_days === 1 ? '' : 's'} in a row`}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
