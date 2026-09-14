import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, Field, LoadingState, Notice, Screen } from '../../src/ui/components';
import { RichNoteEditor } from '../../src/ui/rich-note-editor';
import { deleteNote, fetchNote, noteImageUrls, saveNote, uploadNoteImage } from '../../src/data/notes';
import { canMakeCards, describeSaved, MIN_WORDS_FOR_CARDS, noteWordCount } from '../../src/core/notes';
import {
  docToText,
  forStorage,
  imagePaths,
  textToDoc,
  withImageSources,
  type RichDoc,
} from '../../src/core/rich-note';

/** How long after the last keystroke a save fires. */
const SAVE_DEBOUNCE_MS = 1200;

/**
 * Writing a note (Phase 10), formatted and with pictures since NOTES §43.
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
 *
 * ## Formatting and pictures
 *
 * The editor (`src/ui/rich-note-editor.web.tsx`) hands back the whole document
 * on every change. Each save writes it as `content`, with pictures by path only,
 * and writes its plain text as `body` — so the word count below, the Notes list
 * and "Make flashcards" all keep reading what they always read. A note written
 * before the editor opens from its `body`, and gains `content` the first time
 * it is edited.
 */
export default function NoteEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const noteId = String(id);
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: note, isLoading } = useQuery({
    queryKey: ['note', noteId],
    queryFn: () => fetchNote(noteId),
  });

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pictures, setPictures] = useState(0);
  /** The document the editor opens with, pictures linked. Null until those links are ready. */
  const [openingDoc, setOpeningDoc] = useState<RichDoc | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [pictureError, setPictureError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tick, setTick] = useState(0);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What is actually on screen, readable from a callback without re-creating
  // it on every keystroke — the unmount save reads this, not stale state.
  const latest = useRef<{ title: string; body: string; content: RichDoc | null }>({ title: '', body: '', content: null });
  const loaded = useRef(false);

  // Fill the fields once. Re-filling on every refetch would overwrite what
  // someone is typing with what the server last heard.
  useEffect(() => {
    if (!note || loaded.current) return;
    loaded.current = true;
    setTitle(note.title);
    setBody(note.body);
    latest.current = { title: note.title, body: note.body, content: note.content };

    const stored = note.content ?? textToDoc(note.body);
    const paths = imagePaths(stored);
    setPictures(paths.length);
    void noteImageUrls(paths).then((urls) => setOpeningDoc(withImageSources(stored, urls)));
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

  const scheduleSave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  }, [save]);

  function editedTitle(next: string) {
    latest.current = { ...latest.current, title: next };
    setTitle(next);
    scheduleSave();
  }

  const editedDoc = useCallback(
    (doc: RichDoc) => {
      const content = forStorage(doc);
      const text = docToText(content);
      latest.current = { ...latest.current, body: text, content };
      setBody(text);
      setPictures(imagePaths(content).length);
      scheduleSave();
    },
    [scheduleSave],
  );

  const addImage = useCallback((image: Blob) => uploadNoteImage(noteId, image), [noteId]);

  const pictureProblem = useCallback((message: string) => setPictureError(message), []);

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
      // Opened straight from a link or after a reload there is nothing to go
      // back to, and `back()` did nothing: the note was gone and its screen
      // stayed. Found by the §43 probe.
      if (router.canGoBack()) router.back();
      else router.replace('/notes');
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
  // Pictures are enough on their own: each one is read for cards.
  const ready = canMakeCards(body) || pictures > 0;
  // `tick` is never read for its value: the setState alone re-renders, which is
  // what makes "Saved 3 minutes ago" age without a per-second counter.
  void tick;
  const savedLabel = describeSaved(savedAt, Date.now());

  return (
    <Screen>
      <Field
        label="Title"
        value={title}
        onChangeText={editedTitle}
        placeholder="What is this about?"
        maxLength={200}
      />

      {openingDoc ? (
        <RichNoteEditor
          initialDoc={openingDoc}
          onChange={editedDoc}
          onAddImage={addImage}
          onError={pictureProblem}
          // Landing straight in the body: the title is optional and the first
          // line of the note becomes one anyway (see noteTitle).
          autoFocus
        />
      ) : (
        <LoadingState />
      )}

      {/* Two quiet facts, in the order they are wanted: is my work safe, and
          have I written enough to make cards yet. */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Body muted>{savedLabel ?? ' '}</Body>
        <Body muted>
          {words} word{words === 1 ? '' : 's'}
          {pictures > 0 ? ` · ${pictures} picture${pictures === 1 ? '' : 's'}` : ''}
        </Body>
      </View>

      {saveError ? (
        <Notice tone="error">
          Couldn't save just now — your words are still here on screen. Check your connection and
          keep typing; it will try again.
        </Notice>
      ) : null}
      {pictureError ? <Notice tone="error">{pictureError}</Notice> : null}

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
          {MIN_WORDS_FOR_CARDS - words === 1 ? '' : 's'}, or add a picture, and I can turn this into cards.
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
            The note and its pictures go for good. Any cards you already made from it stay where they are.
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
