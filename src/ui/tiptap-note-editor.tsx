import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import { imagePaths, MAX_NOTE_IMAGES, NOTE_IMAGE_MAX_SIDE, type RichDoc } from '../core/rich-note';
import { MAX_NOTE_CHARS } from '../core/notes';
import { INPUT_FONT_SIZE, radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import { pickImages, shrinkImage } from './shrink-image';
import type { RichNoteEditorProps } from './rich-note-editor.props';

/**
 * The note editor on the web: formatting as you type, and pictures (NOTES §43).
 *
 * The owner asked for notes *"just like notion's features"* — bullets, bold,
 * pictures — and chose a real editor over a toolbar that writes markup. Tiptap
 * (MIT; ProseMirror underneath) does the editing. Typing "- " starts a list,
 * "1. " a numbered one, "# " a heading, "> " a quote, and **two asterisks**
 * bold, the way Notion does; the toolbar is there for a phone, where nobody
 * types markdown.
 *
 * A picture is shrunk on the phone, kept in the private `note-images` bucket,
 * and placed in the note with its PATH (see `src/core/rich-note.ts`); the link
 * it shows through is fresh when the note opens and is never saved. Paste or
 * drop a picture and it is added the same way.
 *
 * **Only ever fetched, never imported.** `rich-note-editor.web.tsx` loads this
 * with `import()` the first time a note is opened, which gives it — and Tiptap —
 * a file of their own. Imported directly, Tiptap is on every start of the app
 * (measured in NOTES §43); `tests/screens.test.ts` holds that line.
 *
 * The editor draws real DOM inside the React Native tree, which
 * react-native-web allows, and styles it with one injected stylesheet using the
 * theme's colours.
 */

/** A picture that also remembers where it is stored. */
const NoteImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      path: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-path'),
        renderHTML: (attributes: { path?: string | null }) =>
          attributes.path ? { 'data-path': attributes.path } : {},
      },
    };
  },
});

const STYLE_ID = 'nomi-note-editor-style';

// Text is never under 16px: iOS zooms the page when a smaller field is focused
// and does not zoom back. See INPUT_FONT_SIZE.
function stylesheet(colors: { text: string; muted: string; border: string; accent: string; code: string }): string {
  return `
.nomi-note { outline: none; min-height: 320px; padding: 12px 14px; color: ${colors.text};
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: ${INPUT_FONT_SIZE}px; line-height: 1.6; word-wrap: break-word; white-space: pre-wrap; }
.nomi-note > * + * { margin-top: 6px; }
.nomi-note p { margin: 0; }
.nomi-note h1 { font-size: 24px; line-height: 1.3; margin: 14px 0 4px; font-weight: 700; }
.nomi-note h2 { font-size: 20px; line-height: 1.3; margin: 12px 0 4px; font-weight: 700; }
.nomi-note h3 { font-size: 18px; line-height: 1.3; margin: 10px 0 2px; font-weight: 600; }
.nomi-note ul, .nomi-note ol { padding-left: 24px; margin: 0; }
.nomi-note li p { margin: 0; }
.nomi-note blockquote { margin: 0; padding-left: 12px; border-left: 3px solid ${colors.border}; color: ${colors.muted}; }
.nomi-note code { background: ${colors.code}; border-radius: 4px; padding: 0 4px; font-size: 0.92em; }
.nomi-note pre { background: ${colors.code}; border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
.nomi-note pre code { background: none; padding: 0; }
.nomi-note hr { border: none; border-top: 1px solid ${colors.border}; margin: 12px 0; }
.nomi-note img { display: block; max-width: 100%; height: auto; border-radius: 10px; margin: 8px 0; }
.nomi-note img.ProseMirror-selectednode { outline: 3px solid ${colors.accent}; }
.nomi-note a { color: ${colors.accent}; }
.nomi-note p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: ${colors.muted};
  float: left; height: 0; pointer-events: none; }
`;
}

export default function TiptapNoteEditor({ initialDoc, onChange, onAddImage, onError, autoFocus }: RichNoteEditorProps) {
  const t = useTheme();
  const [adding, setAdding] = useState(0);

  // Callbacks read through refs: the editor is created once, and a handler
  // captured then would call the screen's first render forever after.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const addFilesRef = useRef<(files: File[]) => void>(() => {});

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      NoteImage.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder: 'Start typing… "- " starts a list, "# " a heading.' }),
      // The ceiling the plain box had as maxLength: typing stops there.
      CharacterCount.configure({ limit: MAX_NOTE_CHARS }),
    ],
    content: initialDoc,
    autofocus: autoFocus ? 'end' : false,
    shouldRerenderOnTransaction: false,
    onUpdate: ({ editor: current }) => onChangeRef.current(current.getJSON() as RichDoc),
    editorProps: {
      attributes: { class: 'nomi-note', 'aria-label': 'Note' },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        addFilesRef.current(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        addFilesRef.current(files);
        return true;
      },
    },
  });

  addFilesRef.current = (files: File[]) => {
    if (!editor) return;
    const room = MAX_NOTE_IMAGES - imagePaths(editor.getJSON() as RichDoc).length;
    if (room <= 0) {
      onError(`A note holds up to ${MAX_NOTE_IMAGES} pictures.`);
      return;
    }
    const taking = files.slice(0, room);
    if (taking.length < files.length) onError(`A note holds up to ${MAX_NOTE_IMAGES} pictures — added the first ${taking.length}.`);
    for (const file of taking) {
      setAdding((n) => n + 1);
      void (async () => {
        try {
          const small = await shrinkImage(file, NOTE_IMAGE_MAX_SIDE);
          const { path, url } = await onAddImage(small);
          editor.chain().focus().insertContent({ type: 'image', attrs: { src: url, path } }).run();
        } catch (err) {
          onError(err instanceof Error && err.message ? err.message : "Couldn't add that picture just now.");
        } finally {
          setAdding((n) => n - 1);
        }
      })();
    }
  };

  // One stylesheet, rewritten when the theme changes.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = stylesheet({ text: t.text, muted: t.textMuted, border: t.border, accent: t.accent, code: t.infoBg });
  }, [t]);

  return (
    <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: radius.md, backgroundColor: t.bg, overflow: 'hidden' }}>
      {editor ? <Toolbar editor={editor} adding={adding > 0} onPicture={() => void pickImages().then((f) => f.length && addFilesRef.current(f))} /> : null}
      <EditorContent editor={editor} />
    </View>
  );
}

/** The formatting a phone cannot type: one row, wrapping when narrow. */
function Toolbar({ editor, adding, onPicture }: { editor: Editor; adding: boolean; onPicture: () => void }) {
  const t = useTheme();
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      bullets: e.isActive('bulletList'),
      numbers: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
    }),
  });

  const tools: { label: string; name: string; active: boolean; run: () => void; strong?: boolean; italic?: boolean }[] = [
    { label: 'B', name: 'Bold', active: state.bold, strong: true, run: () => editor.chain().focus().toggleBold().run() },
    { label: 'I', name: 'Italic', active: state.italic, italic: true, run: () => editor.chain().focus().toggleItalic().run() },
    { label: 'H1', name: 'Heading', active: state.h1, run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: 'H2', name: 'Subheading', active: state.h2, run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: '•', name: 'Bulleted list', active: state.bullets, run: () => editor.chain().focus().toggleBulletList().run() },
    { label: '1.', name: 'Numbered list', active: state.numbers, run: () => editor.chain().focus().toggleOrderedList().run() },
    { label: '❝', name: 'Quote', active: state.quote, run: () => editor.chain().focus().toggleBlockquote().run() },
  ];

  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: space.xs,
        padding: space.xs,
        borderBottomWidth: 1,
        borderBottomColor: t.border,
        backgroundColor: t.card,
      }}
    >
      {tools.map((tool) => (
        <Pressable
          key={tool.name}
          accessibilityRole="button"
          accessibilityLabel={tool.name}
          accessibilityState={{ selected: tool.active }}
          onPress={tool.run}
          style={{
            minWidth: TOUCH_TARGET,
            minHeight: TOUCH_TARGET,
            paddingHorizontal: space.sm,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.sm,
            backgroundColor: tool.active ? t.accent : 'transparent',
          }}
        >
          <Text
            style={[
              type.label,
              {
                color: tool.active ? t.accentText : t.text,
                fontWeight: tool.strong ? '800' : '600',
                fontStyle: tool.italic ? 'italic' : 'normal',
              },
            ]}
          >
            {tool.label}
          </Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add a picture"
        onPress={onPicture}
        disabled={adding}
        style={{
          minHeight: TOUCH_TARGET,
          paddingHorizontal: space.md,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: radius.sm,
          opacity: adding ? 0.6 : 1,
        }}
      >
        <Text style={[type.label, { color: t.accent }]}>{adding ? 'Adding…' : 'Picture'}</Text>
      </Pressable>
    </View>
  );
}
