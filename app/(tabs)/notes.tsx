import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, ListRow, Notice, Screen, Title } from '../../src/ui/components';
import { listNotes, createNote, NotesUnavailableError } from '../../src/data/notes';
import { noteTitle, notePreview } from '../../src/core/notes';

/**
 * The notebook (Phase 10).
 *
 * The owner's brief: *"let's say i'm in class writing notes using the learning
 * app, it would be great if there's a button to immediately transform the notes
 * into flashcards."*
 *
 * ## What is deliberately absent
 *
 * No folders, no tags, no formatting, no search. This is for typing during a
 * lecture with one hand, and every one of those is a thing to fiddle with
 * instead of writing. A flat list, newest edit first, is navigable at the size
 * a student's notebook actually reaches.
 */
export default function Notes() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: notes = [], isLoading, error } = useQuery({
    queryKey: ['notes'],
    queryFn: listNotes,
    // A missing table is a migration that has not been applied, not a blip.
    retry: (count, err) => !(err instanceof NotesUnavailableError) && count < 1,
  });

  // Created empty and opened straight away, so the first keystroke already has
  // a row to go into rather than the first save being the riskiest one.
  const startNote = useMutation({
    mutationFn: createNote,
    onSuccess: async (note) => {
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      router.push(`/note/${note.id}`);
    },
  });

  if (isLoading) {
    return (
      <Screen>
        <Title>Notes</Title>
        <Body muted>Loading…</Body>
      </Screen>
    );
  }

  if (error instanceof NotesUnavailableError) {
    return (
      <Screen>
        <Title>Notes</Title>
        <Card>
          <Body>The notebook isn't switched on yet.</Body>
          <Body muted>
            Nothing is missing from your account — this part of the app just needs to be set up.
            Everything else works as normal.
          </Body>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Notes</Title>

      <Button
        label="+ New note"
        onPress={() => startNote.mutate()}
        busy={startNote.isPending}
      />

      {startNote.isError ? (
        <Notice tone="error">Couldn't start a note just now. Try again in a moment.</Notice>
      ) : null}

      {notes.length === 0 ? (
        <Card>
          <Body>Nothing written yet.</Body>
          <Body muted>
            Type your notes here during class, then turn them into cards when you're done.
          </Body>
        </Card>
      ) : (
        notes.map((note) => (
          <ListRow
            key={note.id}
            title={noteTitle(note)}
            // The preview, and whether cards already came out of it — the one
            // piece of state about a note that is worth seeing from the list.
            meta={`${note.study_set_id ? 'Cards made · ' : ''}${notePreview(note)}`}
            onPress={() => router.push(`/note/${note.id}`)}
          />
        ))
      )}
    </Screen>
  );
}
