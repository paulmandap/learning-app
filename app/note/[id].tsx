import { useCallback, useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, Field, LoadingState, Notice, Screen } from '../../src/ui/components';
import { INPUT_FONT_SIZE, space, useTheme } from '../../src/ui/theme';
import { deleteNote, fetchNote, saveNote } from '../../src/data/notes';
import {
  canMakeCards,
  describeSaved,
  MAX_NOTE_CHARS,
  MIN_WORDS_FOR_CARDS,
  noteWordCount,
} from '../../src/core/notes';

/** How long after the last keystroke a save fires. */
const SAVE_DEBOUNCE_MS = 1200;

/**
 * Writing a note (Phase 10).
 *
 * ## Saving is the whole design
 *
 * Cards can be regenerated; an hour of someone's own writing in a lecture
 * cannot. So:
 *
 *  - it saves 1.2 s after the typing stops, not on a Save button someone will
 *    forget in a rush to pack up;
 *  - it saves again on the way out, so leaving mid-sentence loses nothing;
 *  - **a failed save is stated, loudly, and the text stays on screen.** The
 *    project's own recorded lesson is that anything failing silently costs a
 *    wrong conclusion; here it would cost the notes themselves.
 *
 * The debounce is a ref rather than state so a keystroke does not re-render the
 * editor to reschedule a timer — at speed that is the difference between typing
 * and fighting the field.
 */
export default function NoteEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const noteId = String(id);
  const router = useRouter();
  const t = useTheme();
  const queryClient = useQueryClient();

  const { data: note, isLoading } = useQuery({
    queryKey: ['note', noteId],
    queryFn: () => fetchNote(noteId),
  });

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tick, setTick] = useState(0);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What is actually on screen, readable from a callback without re-creating
  // it on every keystroke — the unmount save reads this, not stale state.
  const latest = useRef({ title: '', body: '' });
  const loaded = useRef(false);

  // Fill the fields once. Re-filling on every refetch would overwrite what
  // someone is typing with what the server last heard.
  useEffect(() => {
    if (!note || loaded.current) return;
    setTitle(note.title);
    setBody(note.body);
    latest.current = { title: note.title, body: note.body };
    loaded.current = true;
  }, [note]);

  const save = useCallback(async () => {
    try {
      await saveNote({ id: noteId, ...latest.current });
      setSavedAt(Date.now());
      setSaveError(false);
      // The list sorts by last edit and shows a preview, so it is stale now.
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
      // And so is the cached copy of THIS note. `/new` reads the note back from
      // that cache to make cards from it, and queries here are fresh for 30
      // seconds — so without this, tapping "Make flashcards" straight after
      // typing a paragraph would generate cards from the text as it was before
      // that paragraph, silently and with nothing on screen to suggest it.
      void queryClient.invalidateQueries({ queryKey: ['note', noteId] });
    } catch {
      setSaveError(true);
    }
  }, [noteId, queryClient]);

  function edited(next: { title?: string; body?: string }) {
    latest.current = { ...latest.current, ...next };
    if (next.title !== undefined) setTitle(next.title);
    if (next.body !== undefined) setBody(next.body);

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  }

  // Leaving the screen saves immediately rather than losing the pending debounce
  // — closing the tab mid-sentence is the normal way a lecture ends.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (loaded.current) void saveNote({ id: noteId, ...latest.current }).catch(() => {});
    };
  }, [noteId]);

  // Keeps "Saved 3 minutes ago" honest without a per-second counter.
  useEffect(() => {
    const every = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(every);
  }, []);

  async function removeNote() {
    try {
      // Stop the unmount save from writing the note back after it is gone.
      loaded.current = false;
      if (timer.current) clearTimeout(timer.current);
      await deleteNote(noteId);
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      router.back();
    } catch {
      loaded.current = true;
      setSaveError(true);
    }
  }

  if (isLoading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (!note) {
    return (
      <Screen>
        <Card>
          <Body>That note isn't here any more.</Body>
          <Button label="Back to notes" variant="secondary" onPress={() => router.back()} />
        </Card>
      </Screen>
    );
  }

  const words = noteWordCount(body);
  const ready = canMakeCards(body);
  // `tick` is never read for its value: the setState alone re-renders, which is
  // what makes "Saved 3 minutes ago" age without a per-second counter.
  void tick;
  const savedLabel = describeSaved(savedAt, Date.now());

  return (
    <Screen>
      <Field
        label="Title"
        value={title}
        onChangeText={(v) => edited({ title: v })}
        placeholder="What is this about?"
        maxLength={200}
      />

      <TextInput
        value={body}
        onChangeText={(v) => edited({ body: v })}
        placeholder="Start typing…"
        placeholderTextColor={t.textMuted}
        multiline
        maxLength={MAX_NOTE_CHARS}
        // Landing straight in the body: the title is optional and the first
        // line of the note becomes one anyway (see noteTitle).
        autoFocus
        style={{
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.bg,
          color: t.text,
          borderRadius: 8,
          padding: space.md,
          // Tall enough to hold a lecture's worth without the page jumping
          // every few lines.
          minHeight: 320,
          // Never below 16: iOS zooms the page when a smaller field is focused
          // and does not zoom back. See INPUT_FONT_SIZE.
          fontSize: INPUT_FONT_SIZE,
          lineHeight: 24,
          textAlignVertical: 'top',
        }}
      />

      {/* Two quiet facts, in the order they are wanted: is my work safe, and
          have I written enough to make cards yet. */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Body muted>{savedLabel ?? ' '}</Body>
        <Body muted>
          {words} word{words === 1 ? '' : 's'}
        </Body>
      </View>

      {saveError ? (
        <Notice tone="error">
          Couldn't save just now — your words are still here on screen. Check your connection and
          keep typing; it will try again.
        </Notice>
      ) : null}

      <Button
        label="Make flashcards from this"
        disabled={!ready}
        onPress={async () => {
          // Save first, then hand over: /new reads the note from the database,
          // so an unsaved last paragraph would simply not become cards.
          if (timer.current) clearTimeout(timer.current);
          await save();
          router.push(`/new?noteId=${noteId}`);
        }}
      />
      {!ready ? (
        <Body muted>
          Write about {Math.max(1, MIN_WORDS_FOR_CARDS - words)} more word
          {MIN_WORDS_FOR_CARDS - words === 1 ? '' : 's'} and I can turn this into cards.
        </Body>
      ) : null}

      {note.study_set_id ? (
        <Button
          label="Open the cards from this note"
          variant="secondary"
          onPress={() => router.push(`/set/${note.study_set_id}`)}
        />
      ) : null}

      {/* Deleting is deliberately last, quiet, and behind a confirm: it is the
          one action here that destroys something that cannot be regenerated. */}
      {confirmDelete ? (
        <Card>
          <Body>Delete this note?</Body>
          <Body muted>
            The note goes for good. Any cards you already made from it stay where they are.
          </Body>
          <Button label="Yes, delete it" onPress={removeNote} />
          <Button label="Keep it" variant="secondary" onPress={() => setConfirmDelete(false)} />
        </Card>
      ) : (
        <Button label="Delete note" variant="secondary" onPress={() => setConfirmDelete(true)} />
      )}
    </Screen>
  );
}
