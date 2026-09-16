import { useEffect, useMemo } from 'react';
import { Image, Platform, Pressable, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { AVATAR_FACES } from '../core/palette';
import { defaultFaceIndex, faceValue, parseAvatar, photoValue } from '../core/avatar';
import { avatarPhotoUrl } from '../data/profile';
import { cachedAvatar, rememberAvatarPhoto, rememberAvatarValue } from '../data/avatar-cache';
import { space, TOUCH_TARGET, useTheme } from './theme';

/**
 * A profile picture: an uploaded photo, or one of the built-in faces.
 *
 * The faces are drawn from Views, like the tab icons — two eyes and a mouth on
 * a colour — so they are crisp at 28 points in a heading and at 96 in Settings,
 * weigh nothing, and look the same on every device. The owner asked for
 * defaults "like Netflix" (NOTES §36): a friendly face, not a grey silhouette.
 *
 * ## Drawn from this device first (NOTES §40)
 *
 * A photo took three round trips to appear — the profile, a signed link, the
 * picture — with the default face in its place for about a second on every
 * launch. The last picture shown is now kept on the device
 * (`src/data/avatar-cache.ts`) and drawn before the profile has even loaded;
 * the network is asked only for a picture this device has not kept.
 */
export function Avatar({
  value,
  userId,
  size = 44,
}: {
  /** The profile's avatar. Undefined while the profile is still loading. */
  value: string | null | undefined;
  userId: string;
  size?: number;
}) {
  const cached = useMemo(() => cachedAvatar(userId), [userId]);
  // Until the profile says otherwise, what this device showed last time.
  const known = value !== undefined ? value : (cached?.value ?? null);
  const choice = parseAvatar(known, userId);
  const photoPath = choice.kind === 'photo' ? choice.path : null;
  const stored = photoPath !== null && cached?.photo?.path === photoPath ? cached.photo.dataUrl : null;

  useEffect(() => {
    if (value !== undefined) rememberAvatarValue(userId, value);
  }, [userId, value]);

  const { data: url } = useQuery({
    queryKey: ['avatar-url', photoPath],
    queryFn: () => avatarPhotoUrl(photoPath!),
    enabled: photoPath !== null && stored === null,
    // The link lasts an hour; refresh well before it lapses.
    staleTime: 50 * 60 * 1000,
  });

  // A photo this device has not kept: keep it once, for the next launch. This
  // one goes on showing the link, so the picture does not swap mid-view.
  useEffect(() => {
    if (!url || photoPath === null || stored !== null) return;
    void rememberAvatarPhoto(userId, photoPath, url);
  }, [url, photoPath, stored, userId]);

  if (choice.kind === 'photo') {
    const source = stored ?? url;
    // Until there is a picture to draw, the person's default face rather than
    // an empty circle — a picture that has to load should never look like no picture.
    if (!source) return <Face index={defaultFaceIndex(userId)} size={size} />;
    return (
      <Image
        source={{ uri: source }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        accessibilityLabel="Your profile picture"
      />
    );
  }
  return <Face index={choice.index} size={size} />;
}

/**
 * Somebody ELSE's picture — in the chat, and beside a set they shared.
 *
 * ## Why this is still not `Avatar`
 *
 * It began as the component that provably could not leak a photo: migration
 * 0021's views turned an uploaded photo into null, and this drew a face with no
 * network call in it at all. Migration 0023 reverses that at the owner's
 * request — *"my dp isn't shown hahaha, i want it shown"* — so it now resolves
 * a photo like `Avatar` does.
 *
 * It stays separate because `Avatar` does two things that are still wrong for
 * another person: it reads and writes this device's avatar cache keyed by the
 * user's id, which would fill it with four other people's avatars and make
 * their photos outlive a sign-out; and it labels the picture "Your profile
 * picture". Here the name is the person's own.
 *
 * ## The photo can only ever be the one they are using
 *
 * Not a decision this component makes. `is_chosen_avatar` in 0023 serves a file
 * from the avatars bucket only while it is the value in that person's
 * `profiles.avatar`; the five older photos the bucket keeps as choices stay as
 * private as they were. So a stale path here does not resolve — which is also
 * why a failed link falls back to the face rather than to an empty circle.
 *
 * A null avatar is not a failure either — it is somebody who has not chosen
 * one — and they get the default face derived from their user id, stable for
 * that person everywhere.
 */
export function PersonAvatar({
  avatar,
  userId,
  name,
  size = 32,
}: {
  avatar: string | null;
  userId: string;
  /** Whose picture it is, for anyone who cannot see it. */
  name?: string;
  size?: number;
}) {
  const choice = parseAvatar(avatar, userId);
  const photoPath = choice.kind === 'photo' ? choice.path : null;

  const { data: url } = useQuery({
    // The same key `Avatar` uses, so a person who appears in the chat twenty
    // times costs one signed link, and their own picture on Home costs none.
    queryKey: ['avatar-url', photoPath],
    queryFn: () => avatarPhotoUrl(photoPath!),
    enabled: photoPath !== null,
    staleTime: 50 * 60 * 1000,
  });

  if (photoPath !== null && url) {
    return (
      <Image
        source={{ uri: url }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        accessibilityLabel={name ? `${name}'s profile picture` : 'Profile picture'}
      />
    );
  }

  // Their face until the link arrives, and their face for good if it never
  // does — a picture that has to load should never look like no picture.
  const index = choice.kind === 'face' ? choice.index : defaultFaceIndex(userId);
  return <Face index={index} size={size} />;
}

/** One built-in face. */
export function Face({ index, size }: { index: number; size: number }) {
  const face = AVATAR_FACES[index] ?? AVATAR_FACES[0]!;
  const eye = Math.max(2, Math.round(size * 0.11));
  const mouthW = size * 0.38;
  const mouthH = size * 0.19;
  const stroke = Math.max(1.5, size * 0.065);

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: face.bg,
        overflow: 'hidden',
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {[0.34, 0.66].map((x) => (
        <View
          key={x}
          style={{
            position: 'absolute',
            left: size * x - eye / 2,
            top: size * 0.4 - eye / 2,
            width: eye,
            height: eye,
            borderRadius: eye / 2,
            backgroundColor: face.ink,
          }}
        />
      ))}
      <View
        style={{
          position: 'absolute',
          left: (size - mouthW) / 2,
          top: size * 0.56,
          width: mouthW,
          height: mouthH,
          borderBottomLeftRadius: mouthH,
          borderBottomRightRadius: mouthH,
          ...(face.expression === 'grin'
            ? { backgroundColor: face.ink }
            : {
                borderColor: face.ink,
                borderLeftWidth: stroke,
                borderRightWidth: stroke,
                borderBottomWidth: stroke,
                borderTopWidth: 0,
              }),
        }}
      />
    </View>
  );
}

/**
 * Choose a face. Every face is a full touch target, and the chosen one wears a
 * ring as well as being announced, so the choice never rests on colour alone.
 */
export function FacePicker({
  selected,
  onPick,
  disabled,
}: {
  /** Index of the face in use, or null when a photo is. */
  selected: number | null;
  onPick: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
      {AVATAR_FACES.map((_, index) => {
        const isSelected = index === selected;
        return (
          <Pressable
            key={index}
            accessibilityRole="button"
            accessibilityLabel={`Face ${index + 1}${isSelected ? ', chosen' : ''}`}
            accessibilityState={{ selected: isSelected, disabled: !!disabled }}
            onPress={() => !disabled && onPick(faceValue(index))}
            style={choiceTile(isSelected, disabled, t.accent)}
          >
            <Face index={index} size={CHOICE_SIZE} />
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The photos they have uploaded, as choices beside the faces (NOTES §45) — the
 * same tile and the same ring.
 */
export function PhotoPicker({
  photos,
  links,
  selected,
  onPick,
  disabled,
}: {
  /** Paths, newest first. */
  photos: readonly string[];
  /** A signed link for each path that has one. */
  links: Readonly<Record<string, string>>;
  /** The path of the photo in use, or null when a face is. */
  selected: string | null;
  onPick: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
      {photos.map((path, index) => {
        const isSelected = path === selected;
        const link = links[path];
        return (
          <Pressable
            key={path}
            accessibilityRole="button"
            accessibilityLabel={`Photo ${index + 1}${isSelected ? ', chosen' : ''}`}
            accessibilityState={{ selected: isSelected, disabled: !!disabled }}
            onPress={() => !disabled && onPick(photoValue(path))}
            style={choiceTile(isSelected, disabled, t.accent)}
          >
            {link ? (
              <Image
                source={{ uri: link }}
                style={{ width: CHOICE_SIZE, height: CHOICE_SIZE, borderRadius: CHOICE_SIZE / 2 }}
              />
            ) : (
              // Until its link arrives, a plain circle the size of the photo.
              <View style={{ width: CHOICE_SIZE, height: CHOICE_SIZE, borderRadius: CHOICE_SIZE / 2, backgroundColor: t.border }} />
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const CHOICE_SIZE = 48;

/** A picture to choose: a full touch target, ringed when it is the one in use. */
function choiceTile(selected: boolean, disabled: boolean | undefined, accent: string) {
  return {
    width: Math.max(TOUCH_TARGET, CHOICE_SIZE + 8),
    height: Math.max(TOUCH_TARGET, CHOICE_SIZE + 8),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: (CHOICE_SIZE + 8) / 2,
    borderWidth: 2,
    borderColor: selected ? accent : 'transparent',
    opacity: disabled ? 0.6 : 1,
  } as const;
}

/**
 * Let the student pick a picture and hand it back small.
 *
 * Web only, like adding notes from a file: the installed app is a PWA, and a
 * file input is how an iPhone offers the photo library to one. The picture is
 * centre-cropped square and drawn to 256px as JPEG before it leaves the phone —
 * a profile picture shown at 44 points does not need the 4 MB the camera took.
 */
export function pickProfilePhoto(): Promise<Blob | null> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve(await squareJpeg(file, 256));
      } catch (err) {
        reject(err);
      }
    };
    input.click();
  });
}

async function squareJpeg(file: Blob, side: number): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new window.Image();
    img.src = url;
    await img.decode();
    const crop = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('This browser cannot resize pictures.');
    g.imageSmoothingQuality = 'high';
    g.drawImage(
      img,
      (img.naturalWidth - crop) / 2,
      (img.naturalHeight - crop) / 2,
      crop,
      crop,
      0,
      0,
      side,
      side,
    );
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that picture.'))), 'image/jpeg', 0.85),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
