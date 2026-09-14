import { useState } from 'react';
import { TextInput } from 'react-native';
import { docToText, textToDoc } from '../core/rich-note';
import { INPUT_FONT_SIZE, space, useTheme } from './theme';
import type { RichNoteEditorProps } from './rich-note-editor.props';

/**
 * The note editor anywhere but the web: plain text (NOTES §43).
 *
 * The formatted editor is `rich-note-editor.web.tsx` — Tiptap, which needs a
 * browser's contentEditable — and Metro picks that file on the web, which is the
 * only place this app ships. This is here so a native build still compiles and
 * a note's words can still be written. It does not show pictures: editing here
 * would save the note without them, so a native build would need a real editor
 * before shipping.
 */
export function RichNoteEditor({ initialDoc, onChange, autoFocus }: RichNoteEditorProps) {
  const t = useTheme();
  const [text, setText] = useState(() => docToText(initialDoc));

  return (
    <TextInput
      value={text}
      onChangeText={(next) => {
        setText(next);
        onChange(textToDoc(next));
      }}
      placeholder="Start typing…"
      placeholderTextColor={t.textMuted}
      multiline
      autoFocus={autoFocus}
      style={{
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.bg,
        color: t.text,
        borderRadius: 8,
        padding: space.md,
        minHeight: 320,
        fontSize: INPUT_FONT_SIZE,
        lineHeight: 24,
        textAlignVertical: 'top',
      }}
    />
  );
}
