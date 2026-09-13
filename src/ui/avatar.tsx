import { Image, Platform, Pressable, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { AVATAR_FACES } from '../core/palette';
import { defaultFaceIndex, faceValue, parseAvatar } from '../core/avatar';
import { avatarPhotoUrl } from '../data/profile';
import { space, TOUCH_TARGET, useTheme } from './theme';

/**
 * A profile picture: an uploaded photo, or one of the built-in faces.
 *
 * The faces are drawn from Views, like the tab icons — two eyes and a mouth on
 * a colour — so they are crisp at 28 points in a heading and at 96 in Settings,
 * weigh nothing, and look the same on every device. The owner asked for
 * defaults "like Netflix" (NOTES §36): a friendly face, not a grey silhouette.
 */
export function Avatar({
  value,
  userId,
  size = 44,
}: {
  value: string | null | undefined;
  userId: string;
  size?: number;
}) {
  const choice = parseAvatar(value, userId);
  const photoPath = choice.kind === 'photo' ? choice.path : null;

  const { data: url } = useQuery({
    queryKey: ['avatar-url', photoPath],
    queryFn: () => avatarPhotoUrl(photoPath!),
    enabled: photoPath !== null,
    // The link lasts an hour; refresh well before it lapses.
    staleTime: 50 * 60 * 1000,
  });

  if (choice.kind === 'photo') {
    // Until the link arrives, the person's default face rather than an empty
    // circle — a picture that has to load should never look like no picture.
    if (!url) return <Face index={defaultFaceIndex(userId)} size={size} />;
    return (
      <Image
        source={{ uri: url }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        accessibilityLabel="Your profile picture"
      />
    );
  }
  return <Face index={choice.index} size={size} />;
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
  const size = 48;
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
            style={{
              width: Math.max(TOUCH_TARGET, size + 8),
              height: Math.max(TOUCH_TARGET, size + 8),
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: (size + 8) / 2,
              borderWidth: 2,
              borderColor: isSelected ? t.accent : 'transparent',
              opacity: disabled ? 0.6 : 1,
            }}
          >
            <Face index={index} size={size} />
          </Pressable>
        );
      })}
    </View>
  );
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
