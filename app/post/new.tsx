import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Image, Pressable, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Label, LoadingState, Notice, Rows } from '../../src/ui/components';
import { Sheet } from '../../src/ui/sheet';
import { MyAvatar } from '../../src/ui/avatar';
import { RowButton } from '../../src/ui/people';
import { petFrame } from '../../src/ui/pet';
import { EmojiPanel } from '../../src/ui/nomi';
import { SentPostCard } from '../../src/ui/sent-post';
import { GLYPH, Icon, type IconName } from '../../src/ui/glyphs';
import { imageSize, pickImages, shrinkImage } from '../../src/ui/shrink-image';
import { INPUT_FONT_SIZE, NO_FOCUS_RING, radius, space, TOUCH_TARGET, type, useTheme } from '../../src/ui/theme';
import { createPost, editPost, getPost, PostsUnavailableError, type PostPhoto as Photo } from '../../src/data/posts';
import { getPublicSet, listPublicSets } from '../../src/data/community';
import { getAppSnapshot } from '../../src/data/nomi';
import { fetchProfile } from '../../src/data/profile';
import { useSessionStore } from '../../src/data/session';
import {
  AUDIENCES,
  audienceDetail,
  audienceLabel,
  DEFAULT_AUDIENCE,
  POST_IMAGE_MAX_SIDE,
  POST_MAX_LENGTH,
  streakLine,
  validateDraft,
  type Audience,
} from '../../src/core/posts';
import { appendEmoji } from '../../src/core/emoji';
import { petStage, toPetSpecies } from '../../src/core/pet';

/**
 * Write a post, or change one (NOTES §52) — a sheet over whatever opened it
 * since §60, as in the owner's picture: Cancel · New post · Post along the top,
 * your face and who will see it, the words with what is attached inside the
 * same box, and Photo · Flashcard set · Streak · Emoji along the bottom.
 *
 * Words, and at most one of a photo, a shared set or your streak — 0027's
 * `posts_one_attachment`. Friends see it unless you say everyone, and what the
 * choice means is on screen under it, in a sentence, so nobody posts to
 * everyone by not noticing.
 *
 * Opened three ways: from the feed; with `?set=<id>` from a set's ⋯ ("Post
 * about this set"); with `?streak=1` from Progress on the day the pet grows.
 * `?edit=<id>` changes a post's words and who sees it — its photo, set or
 * streak stay as they were posted.
 *
 * Still a route, so every way in keeps working: registered as a transparent
 * modal (app/_layout.tsx), which on the web leaves the screen underneath drawn
 * for the Sheet to dim and blur. Tapping outside with something written asks
 * first, rather than throwing the words away.
 */

type Attachment = 'none' | 'photo' | 'set' | 'streak' | 'shared';

/** A little under the database's 2 MB: shrunk, a phone photo is 150–300 KB. */
const PHOTO_QUALITY = 0.82;

/** The photo's preview in the box — a thumbnail, as in the picture, not the post's full width. */
const THUMB_SIDE = 180;

export default function NewPost() {
  const t = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ set?: string; streak?: string; edit?: string; share?: string }>();
  const editId = typeof params.edit === 'string' ? params.edit : null;
  // Sharing a post to your feed (NOTES §62): the post, in the box, under your words.
  const shareId = !editId && typeof params.share === 'string' ? params.share : null;
  const myId = useSessionStore((s) => s.session?.user.id ?? '');

  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<Audience>(DEFAULT_AUDIENCE);
  const [choosingAudience, setChoosingAudience] = useState(false);
  const [attachment, setAttachment] = useState<Attachment>(
    shareId ? 'shared' : params.streak === '1' ? 'streak' : typeof params.set === 'string' ? 'set' : 'none',
  );
  const [setId, setSetId] = useState<string | null>(typeof params.set === 'string' ? params.set : null);
  const [photo, setPhoto] = useState<(Photo & { preview: string }) | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- editing: what is there already ---
  const editing = useQuery({
    queryKey: ['post', editId],
    queryFn: () => getPost(editId!),
    enabled: editId !== null,
  });
  useEffect(() => {
    if (!editing.data) return;
    setBody(editing.data.body);
    setAudience(editing.data.audience);
  }, [editing.data]);

  // --- what can be attached ---
  const { data: shared = [] } = useQuery({ queryKey: ['public-sets'], queryFn: () => listPublicSets() });
  const mySets = useMemo(() => shared.filter((s) => s.owner_id === myId), [shared, myId]);
  // A set passed in may be somebody else's — "Post about this set" is offered
  // on any shared set — so it is looked up on its own.
  const { data: chosenSet } = useQuery({
    queryKey: ['public-set', setId],
    queryFn: () => getPublicSet(setId!),
    enabled: setId !== null,
  });
  const sharedPost = useQuery({
    queryKey: ['post', shareId],
    queryFn: () => getPost(shareId!),
    enabled: shareId !== null,
  });
  const { data: snapshot } = useQuery({ queryKey: ['nomi-brain'], queryFn: () => getAppSnapshot() });
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const streak = snapshot?.streak ?? 0;
  const pet = toPetSpecies(profile?.pet);

  // Let go of a photo preview when it is replaced or the sheet closes.
  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.preview);
  }, [photo]);

  async function choosePhoto() {
    setError(null);
    const [file] = await pickImages(false);
    if (!file) return;
    try {
      const blob = await shrinkImage(file, POST_IMAGE_MAX_SIDE, PHOTO_QUALITY);
      const size = await imageSize(blob);
      setPhoto({ blob, ...size, preview: URL.createObjectURL(blob) });
      setAttachment('photo');
    } catch {
      setError("Couldn't read that picture. Try another one.");
    }
  }

  function removeAttachment() {
    setAttachment('none');
    setPhoto(null);
    setSetId(null);
  }

  function leave() {
    if (navigation.canGoBack()) router.back();
    else router.replace('/community');
  }

  // Something written or a photo picked is worth a question before it goes.
  const dirty = editId
    ? !!editing.data && (body !== editing.data.body || audience !== editing.data.audience)
    : body.trim().length > 0 || photo !== null;
  function close() {
    if (dirty && !busy) setAskDiscard(true);
    else leave();
  }

  const nothingYet = !editId && body.trim().length === 0 && attachment === 'none';
  const waitingForSet = !editId && attachment === 'set' && !setId;
  const noStreak = !editId && attachment === 'streak' && streak === 0;
  const noShared = attachment === 'shared' && !sharedPost.data;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (editId) {
        await editPost(editId, body, audience);
      } else {
        const draft = {
          body,
          audience,
          setId: attachment === 'set' ? setId : null,
          streak: attachment === 'streak',
          sharedPostId: attachment === 'shared' ? shareId : null,
        };
        const check = validateDraft({ ...draft, photo: attachment === 'photo' && !!photo });
        if (!check.ok) throw new Error(check.reason);
        await createPost(draft, attachment === 'photo' ? photo : null);
      }
      await queryClient.invalidateQueries({ queryKey: ['feed'] });
      await queryClient.invalidateQueries({ queryKey: ['person-posts'] });
      await queryClient.invalidateQueries({ queryKey: ['post'] });
      leave();
    } catch (err) {
      setError(
        err instanceof PostsUnavailableError
          ? "Posts aren't switched on yet."
          : err instanceof Error
            ? err.message
            : "Couldn't post that just now. Try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: TOUCH_TARGET }}>
        <View style={{ flex: 1, alignItems: 'flex-start' }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={close}
            disabled={busy}
            hitSlop={8}
            style={{ minHeight: TOUCH_TARGET, justifyContent: 'center' }}
          >
            <Text style={[type.body, { color: t.text }]}>Cancel</Text>
          </Pressable>
        </View>
        <Text style={[type.bodyStrong, { color: t.text }]} accessibilityRole="header">
          {editId ? 'Edit post' : shareId ? 'Share post' : 'New post'}
        </Text>
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          <RowButton
            label={editId ? 'Save' : 'Post'}
            primary
            onPress={() => void submit()}
            busy={busy}
            disabled={nothingYet || waitingForSet || noStreak || noShared}
          />
        </View>
      </View>
      {askDiscard ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: space.sm,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: t.card,
          }}
        >
          <Text style={[type.body, { color: t.text, flex: 1, minWidth: 140 }]}>
            {editId ? 'Throw away your changes?' : 'Throw away this post?'}
          </Text>
          <RowButton label="Keep writing" onPress={() => setAskDiscard(false)} />
          <RowButton label="Throw away" primary onPress={leave} />
        </View>
      ) : null}
    </View>
  );

  if (editId && editing.isLoading) {
    return (
      <Sheet tall onClose={leave} header={header}>
        <LoadingState />
      </Sheet>
    );
  }

  // A share carries the post it shares and nothing else (0034), so no toolbar.
  const footer = editId || shareId ? null : (
    <>
      {emojiOpen ? <EmojiPanel onPick={(e) => setBody((b) => appendEmoji(b, e))} /> : null}
      <View
        style={{
          flexDirection: 'row',
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.card,
          paddingVertical: space.xs,
        }}
      >
        <Tool icon="photo" label="Photo" name="Add a photo" on={attachment === 'photo'} onPress={() => void choosePhoto()} />
        <Tool
          icon="set"
          label="Flashcard set"
          name="Add a flashcard set"
          on={attachment === 'set'}
          onPress={() => {
            setPhoto(null);
            setAttachment('set');
          }}
        />
        <Tool
          icon="streak"
          label="Streak"
          name="Add your streak"
          on={attachment === 'streak'}
          onPress={() => {
            setPhoto(null);
            setSetId(null);
            setAttachment('streak');
          }}
        />
        <Tool icon="emoji" label="Emoji" name="Emoji" on={emojiOpen} onPress={() => setEmojiOpen((v) => !v)} />
      </View>
    </>
  );

  const name = profile?.display_name?.trim() || 'You';

  return (
    <Sheet tall onClose={close} header={header} footer={footer}>
      {/* ------------------------------------------ who you are, who sees it -- */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <MyAvatar size={44} />
        <View style={{ flex: 1, alignItems: 'flex-start', gap: space.xs }}>
          <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>
            {name}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Who can see it: ${audienceLabel(audience)}`}
            accessibilityState={{ expanded: choosingAudience }}
            onPress={() => setChoosingAudience((v) => !v)}
            hitSlop={6}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.xs,
              minHeight: 32,
              paddingHorizontal: space.sm + space.hair,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: t.border,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon name={audience === 'everyone' ? 'everyone' : 'people'} color={t.text} size={16} />
            <Text style={[type.label, { color: t.text, fontWeight: '600' }]}>{audienceLabel(audience)}</Text>
            <Icon name="down" color={t.textMuted} size={14} />
          </Pressable>
        </View>
      </View>
      {/* What the choice means, always — nobody posts to everyone unnoticed. */}
      <Text style={[type.caption, { color: t.textMuted, marginTop: -space.sm }]}>{audienceDetail(audience)}</Text>

      {choosingAudience ? (
        <View accessibilityRole="radiogroup">
          <Rows card>
            {AUDIENCES.map((a) => {
              const chosen = a === audience;
              return (
                <Pressable
                  key={a}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: chosen }}
                  accessibilityLabel={audienceLabel(a)}
                  onPress={() => {
                    setAudience(a);
                    setChoosingAudience(false);
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.md,
                    minHeight: TOUCH_TARGET + space.sm,
                    paddingHorizontal: space.lg,
                    paddingVertical: space.sm,
                    backgroundColor: pressed ? t.bg : 'transparent',
                  })}
                >
                  <Icon name={a === 'everyone' ? 'everyone' : 'people'} color={t.text} size={22} />
                  <View style={{ flex: 1, gap: space.hair }}>
                    <Text style={[chosen ? type.bodyStrong : type.body, { color: t.text }]}>{audienceLabel(a)}</Text>
                    <Text style={[type.caption, { color: t.textMuted }]}>{audienceDetail(a)}</Text>
                  </View>
                  {/* A mark as well as the weight — never one signal alone. */}
                  <View style={{ width: 22 }}>{chosen ? <Icon name="check" color={t.accent} size={22} /> : null}</View>
                </Pressable>
              );
            })}
          </Rows>
        </View>
      ) : null}

      {/* ---------------------------------- the words, and what is attached -- */}
      <View
        style={{
          gap: space.md,
          padding: space.md,
          borderRadius: radius.md,
          borderWidth: 1,
          // The box's edge is the focus mark, so the browser's own ring is off.
          borderColor: focused ? t.accent : t.border,
          backgroundColor: t.card,
        }}
      >
        <TextInput
          value={body}
          onChangeText={setBody}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={
            attachment === 'streak' || attachment === 'shared' ? 'Say something about it (optional)' : 'What do you want to share?'
          }
          placeholderTextColor={t.textMuted}
          multiline
          maxLength={POST_MAX_LENGTH}
          autoFocus={attachment === 'none' && !editId}
          style={[
            {
              minHeight: 120,
              color: t.text,
              // Never under 16, or iOS zooms the page and stays zoomed.
              fontSize: INPUT_FONT_SIZE,
              textAlignVertical: 'top',
            },
            NO_FOCUS_RING,
          ]}
        />

        {attachment === 'shared' ? (
          sharedPost.isLoading ? (
            <LoadingState />
          ) : sharedPost.data ? (
            <SentPostCard post={sharedPost.data} openable={false} />
          ) : (
            <Text style={[type.body, { color: t.textMuted }]}>That post can&apos;t be shared any more.</Text>
          )
        ) : null}

        {attachment === 'photo' && photo ? (
          <Attached onRemove={removeAttachment} what="the photo">
            <Image
              source={{ uri: photo.preview }}
              style={{
                width: photo.width >= photo.height ? THUMB_SIDE : (THUMB_SIDE * photo.width) / photo.height,
                height: photo.width >= photo.height ? (THUMB_SIDE * photo.height) / photo.width : THUMB_SIDE,
                borderRadius: radius.md,
              }}
              accessibilityLabel="The photo you picked"
            />
          </Attached>
        ) : null}

        {attachment === 'set' && chosenSet ? (
          <Attached onRemove={removeAttachment} what="the set">
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                padding: space.md,
                paddingRight: space.xl + space.md,
                borderRadius: radius.md,
                backgroundColor: t.bg,
              }}
            >
              <Icon name="set" color={t.accent} size={22} />
              <View style={{ flex: 1 }}>
                <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={2}>
                  {chosenSet.title}
                </Text>
                <Text style={[type.caption, { color: t.textMuted }]}>{`${chosenSet.cards} card${chosenSet.cards === 1 ? '' : 's'}`}</Text>
              </View>
            </View>
          </Attached>
        ) : null}

        {attachment === 'streak' ? (
          <Attached onRemove={removeAttachment} what="your streak">
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                padding: space.md,
                // Room for the ✕, so it never sits on the words.
                paddingRight: space.xl + space.md,
                borderRadius: radius.md,
                backgroundColor: t.bg,
              }}
            >
              {streak > 0 ? (
                <>
                  <Image source={petFrame(pet, petStage(streak)?.index ?? 0)} style={{ width: 64, height: 64 }} resizeMode="contain" />
                  <Text style={[type.body, { color: t.text, flex: 1 }]}>{streakLine(streak, pet)}</Text>
                </>
              ) : (
                <Text style={[type.body, { color: t.textMuted, flex: 1 }]}>
                  No streak yet — answer a card today and there will be one to share.
                </Text>
              )}
            </View>
          </Attached>
        ) : null}
      </View>

      {/* Which set, when a set is wanted and none is picked yet. */}
      {waitingForSet ? (
        <View style={{ gap: space.xs }}>
          <Label>Which set?</Label>
          {mySets.length === 0 ? (
            <Body muted>
              {`You haven't shared a set yet. Open one of your sets and choose "Share with everyone" from its ${GLYPH.more} first.`}
            </Body>
          ) : (
            <Rows card>
              {mySets.map((s) => (
                <Pressable
                  key={s.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: false }}
                  accessibilityLabel={s.title}
                  onPress={() => setSetId(s.id)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.md,
                    minHeight: TOUCH_TARGET,
                    paddingHorizontal: space.lg,
                    paddingVertical: space.sm,
                    backgroundColor: pressed ? t.bg : 'transparent',
                  })}
                >
                  <Icon name="set" color={t.accent} size={20} />
                  <Text style={[type.body, { color: t.text, flex: 1 }]}>{s.title}</Text>
                  <Text style={[type.caption, { color: t.textMuted }]}>{`${s.cards} card${s.cards === 1 ? '' : 's'}`}</Text>
                </Pressable>
              ))}
            </Rows>
          )}
        </View>
      ) : null}

      {editId && editing.data && (editing.data.image_path || editing.data.set_id || editing.data.streak_days) ? (
        <Body muted>The photo, set or streak stays as it was posted.</Body>
      ) : null}

      {error ? <Notice tone="error">{error}</Notice> : null}
    </Sheet>
  );
}

/** What is attached, with a ✕ in its corner to take it off again — the picture's photo. */
function Attached({ children, onRemove, what }: { children: ReactNode; onRemove: () => void; what: string }) {
  const t = useTheme();
  return (
    <View style={{ alignSelf: 'flex-start', maxWidth: '100%' }}>
      {children}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${what}`}
        onPress={onRemove}
        hitSlop={8}
        style={{
          position: 'absolute',
          top: space.xs,
          right: space.xs,
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
        }}
      >
        <Icon name="close" color="#ffffff" size={16} />
      </Pressable>
    </View>
  );
}

/** One of the four along the bottom: an icon, its name under it, the accent while it is the one in use. */
function Tool({
  icon,
  label,
  name,
  on,
  onPress,
}: {
  icon: IconName;
  label: string;
  /** What a screen reader says — "Add a photo", not just "Photo". */
  name: string;
  on: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const color = on ? t.accent : t.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityState={{ selected: on }}
      aria-selected={on}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.hair,
        minHeight: TOUCH_TARGET + space.md,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon name={icon} color={color} size={22} />
      <Text style={[type.caption, { color, fontWeight: on ? '700' : '400' }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}
