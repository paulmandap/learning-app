import { useEffect, useRef, useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Body, Button, Card, Field, Notice, Screen, Title } from '../src/ui/components';
import { INPUT_FONT_SIZE, useTheme } from '../src/ui/theme';
import { fetchProfile } from '../src/data/profile';
import { storageUsedBytes } from '../src/data/documents';
import { checkUpload } from '../src/core/storage';
import { createSet } from '../src/data/sets';
import {
  addDocumentToSet,
  extendPlanForDocument,
  planSet,
  type FileSource,
} from '../src/data/pipeline';
import { extractHeadings } from '../src/ai/gemini';
import { fetchNote, linkNoteToSet } from '../src/data/notes';
import { noteTitle } from '../src/core/notes';

const COUNTS = [10, 20, 40, 60] as const;

/**
 * Add notes + set setup, on one screen.
 *
 * The count the user picks is the TARGET, and it is honoured. The old
 * deterministic estimate (floor(words/70)) is gone: it always won, so the
 * picker was decoration — 251 words yielded 3 cards whether you asked for 10
 * or 60. Anti-padding now lives in the generation prompt and the validators,
 * which judge what was actually written rather than guessing from word count.
 */
export default function NewSet() {
  const router = useRouter();
  // When setId is present we are ADDING to an existing set, not creating one.
  // Only the new document is planned, so nothing already generated re-runs.
  //
  // When noteId is present the text comes from the notebook. That arrives HERE
  // rather than the notebook running its own pipeline, because this screen
  // already owns the whole of it — the key check, the count picker, the
  // storage backstop, the error mapping. A second copy would drift from this
  // one the first time either changed.
  const { setId: existingSetId, noteId } = useLocalSearchParams<{
    setId?: string;
    noteId?: string;
  }>();
  const addingToExisting = typeof existingSetId === 'string' && existingSetId.length > 0;
  const fromNote = typeof noteId === 'string' && noteId.length > 0;
  const t = useTheme();
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  // Fetched up front so a file can be refused the instant it is chosen, rather
  // than after it has been sent. Shared query key with the Progress screen.
  const { data: usedBytes = 0 } = useQuery({
    queryKey: ['storageUsed'],
    queryFn: storageUsedBytes,
  });

  const [text, setText] = useState('');
  const [file, setFile] = useState<{ blob: Blob; name: string; mime: string } | null>(null);
  const [title, setTitle] = useState('');
  const [count, setCount] = useState<number>(20);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The note being turned into cards, if we came from the notebook.
  const { data: note } = useQuery({
    queryKey: ['note', noteId],
    queryFn: () => fetchNote(String(noteId)),
    enabled: fromNote,
  });

  // Fill the fields once, and only from a note that actually loaded. Doing it
  // in an effect rather than as initial state because the note arrives after
  // the first render.
  const filledFromNote = useRef(false);
  useEffect(() => {
    if (!note || filledFromNote.current) return;
    setText(note.body);
    setTitle(noteTitle(note));
    filledFromNote.current = true;
  }, [note]);

  const apiKey = profile?.gemini_api_key ?? '';
  const hasInput = text.trim().length > 0 || file !== null;

  function pickFile() {
    if (Platform.OS !== 'web') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.txt,image/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;

      // Refused HERE, before a single byte is sent. Supabase Free gives 1 GB of
      // file storage for the WHOLE project, so a bucket filled by one person
      // fails for everyone else — and the error would land on whoever uploaded
      // next rather than on whoever filled it.
      const verdict = checkUpload({ fileBytes: f.size, usedBytes });
      if (!verdict.ok) {
        setError(verdict.message);
        setFile(null);
        return;
      }

      setError(null);
      setFile({ blob: f, name: f.name, mime: f.type || 'application/pdf' });
      if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
    };
    input.click();
  }

  async function make() {
    if (!apiKey) {
      setError('Add your Gemini key in Settings first.');
      return;
    }
    // Backstop. The check at pick time uses whatever usage figure had loaded by
    // then, and if that query was still in flight it saw 0 — so a large file
    // could clear a per-user test it should have failed.
    if (file) {
      const fresh = await storageUsedBytes();
      const verdict = checkUpload({ fileBytes: file.blob.size, usedBytes: fresh });
      if (!verdict.ok) {
        setError(verdict.message);
        return;
      }
    }

    setBusy(true);
    setError(null);

    try {
      const heading = extractHeadings(text)[0];
      const setName = title.trim() || heading || file?.name || 'My notes';
      const targetId = addingToExisting ? existingSetId : (await createSet(setName)).id;

      setStatus('Reading your notes…');
      const source: { text: string } | FileSource = file
        ? {
            kind: file.mime.startsWith('image/') ? 'image' : 'pdf',
            file: file.blob,
            mime: file.mime,
            filename: file.name,
          }
        : { text };

      const { documentId } = await addDocumentToSet({
        setId: targetId,
        apiKey,
        title: setName,
        source,
      });

      setStatus('Planning your cards…');
      if (addingToExisting) {
        await extendPlanForDocument({ setId: targetId, documentId, requestedCount: count });
      } else {
        await planSet(targetId, count);
      }

      // Remember where a note's cards went, so the note can offer a way back
      // to them. Best effort inside linkNoteToSet — the cards exist either way.
      if (fromNote) await linkNoteToSet(String(noteId), targetId);

      router.replace(`/set/${targetId}`);
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Something went wrong. Please try again.",
      );
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>
        {addingToExisting ? 'Add notes' : fromNote ? 'Make cards from your note' : 'New set'}
      </Title>

      {/* Says where the text came from, and that editing here is safe. Without
          it, seeing your own note in an editable box on a screen called
          "New set" reads as if you are about to change the note itself. */}
      {fromNote ? (
        <Notice tone="ok">
          This is your note. Anything you change here only affects the cards — your note stays as
          you wrote it.
        </Notice>
      ) : null}

      <Card>
        <Body>{fromNote ? 'Your note' : 'Paste your notes'}</Body>
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          numberOfLines={8}
          placeholder="Paste your notes here…"
          placeholderTextColor={t.textMuted}
          style={{
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.bg,
            color: t.text,
            borderRadius: 8,
            padding: 12,
            minHeight: 160,
            // Under 16 and iOS zooms the page the moment this is tapped — see
            // INPUT_FONT_SIZE. This box is the one a student types into for
            // longest, so it is the worst place for it.
            fontSize: INPUT_FONT_SIZE,
            textAlignVertical: 'top',
          }}
        />
        <Body muted>or</Body>
        <Button label="Choose a file (PDF, picture, or .txt)" variant="secondary" onPress={pickFile} />
        {file ? <Notice tone="ok">{file.name}</Notice> : null}
        <Body muted>
          Your notes are sent to Google to make your cards. Someone at Google may read them, so
          please don't add anything private.
        </Body>
      </Card>

      <Card>
        <Field label="Name" value={title} onChangeText={setTitle} placeholder="Cardiac Conduction" autoCapitalize="sentences" />

        <Body>How many cards at most?</Body>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {COUNTS.map((c) => (
            <View key={c} style={{ flexGrow: 1, minWidth: 68 }}>
              <Button
                label={String(c)}
                variant={count === c ? 'primary' : 'secondary'}
                onPress={() => setCount(c)}
              />
            </View>
          ))}
        </View>

        <Body muted>
          We'll make up to this many. If your notes genuinely don't hold that many good
          cards, you'll get fewer rather than filler.
        </Body>
      </Card>

      <Button label="Make my study set" onPress={make} busy={busy} disabled={!hasInput} />
      {status ? <Notice tone="warn">{status}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Screen>
  );
}
