/**
 * Pictures from the phone, made small enough to keep (NOTES §43).
 *
 * Web only, like the profile photo picker in `src/ui/avatar.tsx`: the app ships
 * as a web app, and a file input is how an iPhone offers the photo library to
 * one. A phone photo is 3–12 MB; a picture in a note is read on a phone screen
 * and by Gemini, and neither needs more than about 1600 pixels on its longest
 * side. Never enlarged, always JPEG — a transparent PNG is laid on white first,
 * because JPEG has no transparency and would turn it black.
 */

/** Let the student choose pictures. Resolves to none when they cancel or this is not the web. */
export function pickImages(multiple = true): Promise<File[]> {
  if (typeof document === 'undefined') return Promise.resolve([]);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

/** A picture no larger than `maxSide` on its longest side, as JPEG. */
export async function shrinkImage(file: Blob, maxSide: number, quality = 0.85): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new window.Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('This browser cannot resize pictures.');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, width, height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, width, height);

    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that picture.'))), 'image/jpeg', quality),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
