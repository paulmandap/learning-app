/**
 * Choosing files from the phone or the computer — one way, for every picker in
 * the app: a profile photo, a post's photo, a note's pictures, and notes to
 * make a set from (NOTES §61).
 *
 * ## The box is IN the page until it answers
 *
 * Each picker used to make a file input, click it and wait — without ever
 * putting it in the page. On the owner's iPhone that input could be thrown away
 * while the photo library was open, so the choice was never heard: *"picked a
 * picture, check button, then nothing is happening. no errors"* — and nothing
 * had reached storage. Now it is added to the page, hidden, before it is
 * clicked, and taken out once it has answered.
 *
 * Hidden by being off-screen, not `display: none`: a browser may refuse to open
 * a picker for an input that is not displayed.
 */

/** The one waiting for an answer, if any — taken out when the next is opened. */
let waiting: HTMLInputElement | null = null;

/** Resolves to the chosen files, or none when they cancel or this is not the web. */
export function pickFiles({ accept, multiple = false }: { accept: string; multiple?: boolean }): Promise<File[]> {
  if (typeof document === 'undefined') return Promise.resolve([]);
  // A browser without the `cancel` event leaves the last one unanswered when
  // somebody backs out; it goes now rather than piling up.
  waiting?.remove();

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.setAttribute('aria-hidden', 'true');
    input.tabIndex = -1;
    Object.assign(input.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: '1px',
      height: '1px',
      opacity: '0',
    });

    let answered = false;
    const answer = (files: File[]) => {
      if (answered) return;
      answered = true;
      input.remove();
      if (waiting === input) waiting = null;
      resolve(files);
    };
    input.addEventListener('change', () => answer(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => answer([]));

    document.body.appendChild(input);
    waiting = input;
    input.click();
  });
}

/** A picture that could not be read — too large for the phone, or not a picture. */
export class UnreadablePictureError extends Error {
  constructor() {
    super("Couldn't read that picture. Try another one.");
    this.name = 'UnreadablePictureError';
  }
}

/** How long a picture may take to open before it is given up on — never a silent wait. */
export const PICTURE_OPEN_MS = 20_000;

/**
 * A picture opened for drawing.
 *
 * `onload`/`onerror` rather than `decode()`: `decode()` is newer and has been
 * the less dependable of the two on iPhone Safari with large photos, and
 * either way this can now only end in a picture or in `UnreadablePictureError`
 * — never in waiting forever.
 */
export function openPicture(url: string, timeoutMs = PICTURE_OPEN_MS): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    const timer = setTimeout(() => reject(new UnreadablePictureError()), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) resolve(img);
      else reject(new UnreadablePictureError());
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new UnreadablePictureError());
    };
    img.src = url;
  });
}
