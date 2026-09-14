import type { RichDoc } from '../core/rich-note';

/** What the note screen gives its editor — the same on the web and off it. */
export interface RichNoteEditorProps {
  /** The note as it opens, its pictures already carrying fresh links. Read once. */
  initialDoc: RichDoc;
  /** Every change, as the whole document. */
  onChange: (doc: RichDoc) => void;
  /** Keep a shrunk picture; resolves to where it is stored and a link to show it. */
  onAddImage: (image: Blob) => Promise<{ path: string; url: string }>;
  /** Something to tell the student — a picture that would not add, a limit reached. */
  onError: (message: string) => void;
  autoFocus?: boolean;
}
