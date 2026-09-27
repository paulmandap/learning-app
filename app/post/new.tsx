import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, Label, LoadingState, Notice, PillButton, Screen, Title } from '../../src/ui/components';
import { Segment } from '../../src/ui/segment';
import { PostPhoto } from '../../src/ui/post';
import { petFrame } from '../../src/ui/pet';
import { GLYPH } from '../../src/ui/glyphs';
import { imageSize, pickImages, shrinkImage } from '../../src/ui/shrink-image';
import { INPUT_FONT_SIZE, radius, space, type, useTheme } from '../../src/ui/theme';
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
import { petStage, toPetSpecies } from '../../src/core/pet';

/**
 * Write a post, or change one (NOTES §52).
 *
 * Words, and at most one of a photo, a shared set or your streak — 0027's
 * `posts_one_attachment`. Friends see it unless you say everyone, and the
 * choice is on screen above the button with what it means in a sentence, so
 * nobody posts to everyone by not noticing.
 *
 * Opened three ways: from the feed; with `?set=<id>` from a set's ⋯ ("Post
 * about this set"); with `?streak=1` from Progress on the day the pet grows.
 * `?edit=<id>` changes a post's words and who sees it — its photo, set or
 * streak stay as they were posted.
 */

type Attachment = 'none' | 'photo' | 'set' | 'streak';

const AUDIENCE_OPTIONS = AUDIENCES.map((a) => ({ key: a, label: audienceLabel(a) }));

/** A little under the database's 2 MB: shrunk, a phone photo is 150–300 KB. */
const PHOTO_QUALITY = 0.82;

export default function NewPost() {
  const t = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ set?: string; streak?: string; edit?: string }>();
  const editId = typeof params.edit === 'string' ? params.edit : null;
  const myId = useSessionStore((s) => s.session?.user.id ?? '');

  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<Audience>(DEFAULT_AUDIENCE);
  const [attachment, setAttachment] = useState<Attachment>(
    params.streak === '1' ? 'streak' : typeof params.set === 'string' ? 'set' : 'none',
  );
  const [setId, setSetId] = useState<string | null>(typeof params.set === 'string' ? params.set : null);
  const [photo, setPhoto] = useState<(Photo & { preview: string }) | null>(null);
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
  const { data: snapshot } = useQuery({ queryKey: ['nomi-brain'], queryFn: () => getAppSnapshot() });
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const streak = snapshot?.streak ?? 0;

  // Let go of a photo preview when it is replaced or the screen closes.
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

  function leave() {
    if (navigation.canGoBack()) router.back();
    else router.replace('/community');
  }

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

  if (editId && editing.isLoading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>{editId ? 'Edit post' : 'New post'}</Title>

      <TextInput
        value={body}
        onChangeText={setBody}
        placeholder={attachment === 'streak' ? 'Say something about it (optional)' : 'What do you want to share?'}
        placeholderTextColor={t.textMuted}
        multiline
        maxLength={POST_MAX_LENGTH}
        autoFocus={attachment === 'none' && !editId}
        style={{
          minHeight: 120,
          padding: space.md,
          borderWidth: 1,
          borderColor: t.border,
          borderRadius: radius.sm,
          backgroundColor: t.card,
          color: t.text,
          // Never under 16, or iOS zooms the page and stays zoomed.
          fontSize: INPUT_FONT_SIZE,
          textAlignVertical: 'top',
        }}
      />

      {/* ------------------------------------------------ the attachment -- */}
      {editId ? (
        editing.data && (editing.data.image_path || editing.data.set_id || editing.data.streak_days) ? (
          <Body muted>The photo, set or streak stays as it was posted.</Body>
        ) : null
      ) : (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            <PillButton label={attachment === 'photo' ? 'Change photo' : 'Photo'} onPress={choosePhoto} />
            <PillButton label="A shared set" onPress={() => setAttachment('set')} />
            <PillButton label="My streak" onPress={() => setAttachment('streak')} />
            {attachment !== 'none' ? (
              <PillButton
                label="Remove"
                onPress={() => {
                  setAttachment('none');
                  setPhoto(null);
                  setSetId(null);
                }}
              />
            ) : null}
          </View>

          {attachment === 'photo' && photo ? (
            <PostPhoto uri={photo.preview} width={photo.width} height={photo.height} />
          ) : null}

          {attachment === 'set' ? (
            <Card>
              <Label>Which set?</Label>
              {chosenSet ? (
                <Body strong>{chosenSet.title}</Body>
              ) : null}
              {mySets.length === 0 && !chosenSet ? (
                <Body muted>
                  {`You haven't shared a set yet. Open one of your sets and choose "Share with everyone" from its ${GLYPH.more} first.`}
                </Body>
              ) : null}
              {mySets
                .filter((s) => s.id !== setId)
                .map((s) => (
                  <Pressable
                    key={s.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: s.id === setId }}
                    onPress={() => setSetId(s.id)}
                    style={({ pressed }) => ({ paddingVertical: space.sm, opacity: pressed ? 0.6 : 1 })}
                  >
                    <Text style={[type.body, { color: t.accent }]}>{s.title}</Text>
                  </Pressable>
                ))}
            </Card>
          ) : null}

          {attachment === 'streak' ? (
            <Card>
              {streak > 0 ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
                  <Image
                    source={petFrame(toPetSpecies(profile?.pet), petStage(streak)?.index ?? 0)}
                    style={{ width: 72, height: 72 }}
                    resizeMode="contain"
                  />
                  <Body>{streakLine(streak, toPetSpecies(profile?.pet))}</Body>
                </View>
              ) : (
                <Body muted>No streak yet — answer a card today and there will be one to share.</Body>
              )}
            </Card>
          ) : null}
        </>
      )}

      {/* ------------------------------------------------ who sees it -- */}
      <View style={{ gap: space.sm }}>
        <Label>Who can see it</Label>
        <Segment value={audience} options={AUDIENCE_OPTIONS} onChange={setAudience} role="radio" />
        <Body muted>{audienceDetail(audience)}</Body>
      </View>

      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button
        label={editId ? 'Save' : 'Post'}
        onPress={submit}
        busy={busy}
        disabled={attachment === 'set' && !setId && !editId}
      />
      <Button label="Cancel" variant="secondary" onPress={leave} disabled={busy} />
    </Screen>
  );
}
