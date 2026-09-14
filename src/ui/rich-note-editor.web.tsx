import { lazy, Suspense, useMemo, useState, type ComponentType } from 'react';
import { Button, LoadingState, Notice } from './components';
import type { RichNoteEditorProps } from './rich-note-editor.props';

type EditorModule = { default: ComponentType<RichNoteEditorProps> };

/**
 * The note editor on the web (NOTES §43): the Tiptap editor in
 * `tiptap-note-editor.tsx`, fetched the first time a note is opened.
 *
 * Fetched rather than bundled, on a measurement: imported directly, Tiptap put
 * 502 KB — 146 KB compressed, a quarter again — on every start of the app, for
 * the one screen that edits a note. `import()` gives it a file of its own.
 *
 * If that file will not fetch — offline, or the app was left open across an
 * update, so the file it asks for has been replaced — this says so and offers to
 * try again. It does NOT fall back to a plain text box: saving from one would
 * write the note without its pictures.
 */
function loadEditor() {
  return lazy(
    (): Promise<EditorModule> =>
      import('./tiptap-note-editor').then(
        (m): EditorModule => ({ default: m.default }),
        (err: unknown): EditorModule => {
          console.warn(`[notes] the editor did not load: ${err instanceof Error ? err.message : String(err)}`);
          return { default: EditorUnavailable };
        },
      ),
  );
}

let retry: () => void = () => {};

function EditorUnavailable() {
  return (
    <>
      <Notice tone="error">
        Couldn't open the editor just now. Check your connection, or close Nomi and open it again.
        Your note is safe.
      </Notice>
      <Button label="Try again" variant="secondary" onPress={() => retry()} />
    </>
  );
}

export function RichNoteEditor(props: RichNoteEditorProps) {
  const [attempt, setAttempt] = useState(0);
  retry = () => setAttempt((n) => n + 1);
  // A new lazy component per attempt, so "Try again" fetches again rather than
  // showing the remembered failure.
  const Editor = useMemo(() => {
    void attempt;
    return loadEditor();
  }, [attempt]);

  return (
    <Suspense fallback={<LoadingState what="Opening your note…" />}>
      <Editor {...props} />
    </Suspense>
  );
}
