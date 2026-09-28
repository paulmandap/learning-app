import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPicture, pickFiles, UnreadablePictureError } from '../src/ui/pick-files';

/**
 * Choosing files (NOTES §61).
 *
 * The owner, on a second account on his iPhone: *"picked a picture, check
 * button, then nothing is happening. no errors"* — and nothing had reached
 * storage. Every picker made a file input and clicked it without putting it
 * in the page, and iPhone Safari could lose such an input while the photo
 * library was open. These hold the one picker to being in the page when it is
 * clicked, and every picker in the app to being that one.
 */

class FakeInput {
  type = '';
  accept = '';
  multiple = false;
  tabIndex = 0;
  style: Record<string, string> = {};
  files: File[] | null = null;
  inPageWhenClicked = false;
  private listeners: Record<string, (() => void)[]> = {};
  constructor(private readonly body: FakeBody) {}
  setAttribute() {}
  addEventListener(event: string, fn: () => void) {
    (this.listeners[event] ??= []).push(fn);
  }
  fire(event: string) {
    for (const fn of this.listeners[event] ?? []) fn();
  }
  remove() {
    this.body.children = this.body.children.filter((c) => c !== this);
  }
  click() {
    this.inPageWhenClicked = this.body.children.includes(this);
  }
}

class FakeBody {
  children: FakeInput[] = [];
  appendChild(el: FakeInput) {
    this.children.push(el);
  }
}

let body: FakeBody;
let made: FakeInput[];

beforeEach(() => {
  body = new FakeBody();
  made = [];
  vi.stubGlobal('document', {
    body,
    createElement: () => {
      const input = new FakeInput(body);
      made.push(input);
      return input;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the one file picker', () => {
  it('is in the page when it is clicked, and out of it once it has answered', async () => {
    const picked = pickFiles({ accept: 'image/*' });
    const input = made[0]!;
    expect(input.type).toBe('file');
    expect(input.accept).toBe('image/*');
    expect(input.inPageWhenClicked).toBe(true);

    const photo = { name: 'photo.jpg' } as File;
    input.files = [photo];
    input.fire('change');
    await expect(picked).resolves.toEqual([photo]);
    expect(body.children).toHaveLength(0);
  });

  it('hidden off-screen, never display: none — a browser may not open a picker for that', () => {
    void pickFiles({ accept: 'image/*' });
    expect(made[0]!.style.display).toBeUndefined();
    expect(made[0]!.style.left).toBe('-10000px');
  });

  it('backing out answers with nothing', async () => {
    const picked = pickFiles({ accept: 'image/*' });
    made[0]!.fire('cancel');
    await expect(picked).resolves.toEqual([]);
    expect(body.children).toHaveLength(0);
  });

  it('one never answered goes when the next is opened, rather than piling up', () => {
    void pickFiles({ accept: 'image/*' });
    void pickFiles({ accept: 'image/*' });
    expect(body.children).toEqual([made[1]]);
  });

  it('nothing to choose from without a page', async () => {
    vi.unstubAllGlobals();
    await expect(pickFiles({ accept: 'image/*' })).resolves.toEqual([]);
  });
});

describe('opening a picture ends, one way or the other', () => {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    set src(url: string) {
      if (url === 'good') {
        this.naturalWidth = 4032;
        this.naturalHeight = 3024;
        queueMicrotask(() => this.onload?.());
      } else if (url === 'bad') {
        queueMicrotask(() => this.onerror?.());
      }
      // 'stuck': neither ever comes.
    }
  }

  beforeEach(() => vi.stubGlobal('window', { Image: FakeImage }));

  it('a picture that opens', async () => {
    await expect(openPicture('good')).resolves.toMatchObject({ naturalWidth: 4032, naturalHeight: 3024 });
  });

  it('one that cannot be read says so, in words', async () => {
    await expect(openPicture('bad')).rejects.toBeInstanceOf(UnreadablePictureError);
    await expect(openPicture('bad')).rejects.toThrow("Couldn't read that picture. Try another one.");
  });

  it('one that never answers is given up on — never a silent wait', async () => {
    vi.useFakeTimers();
    const opening = openPicture('stuck', 1000);
    const check = expect(opening).rejects.toBeInstanceOf(UnreadablePictureError);
    await vi.advanceTimersByTimeAsync(1001);
    await check;
  });
});

describe('every picker in the app is that one', () => {
  function sources(dir: string): string[] {
    return (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => join(dir, f));
  }

  it('no other file input is made anywhere', () => {
    for (const file of [...sources('app'), ...sources('src')]) {
      if (file === join('src', 'ui', 'pick-files.ts')) continue;
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\.type = 'file'/);
    }
  });

  it('the profile photo, a post’s photo, a note’s pictures and notes from a file all go through it', () => {
    expect(readFileSync('src/ui/avatar.tsx', 'utf8')).toContain("await pickFiles({ accept: 'image/*' })");
    expect(readFileSync('src/ui/shrink-image.ts', 'utf8')).toContain("return pickFiles({ accept: 'image/*', multiple });");
    expect(readFileSync('app/new.tsx', 'utf8')).toContain("pickFiles({ accept: '.pdf,.txt,image/*' })");
  });

  it('Settings is busy from the moment a photo is chosen, and says when it cannot read one', () => {
    const settings = readFileSync('app/settings.tsx', 'utf8');
    const upload = settings.slice(settings.indexOf('async function uploadPhoto'));
    expect(upload.indexOf('setAvatarBusy(true)')).toBeLessThan(upload.indexOf('await squareProfilePhoto(file)'));
    expect(settings).toContain('if (err instanceof UnreadablePictureError) return err.message;');
  });
});
