import { useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Body, Button, Card, Field, Notice, Screen, Title } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';
import { fetchProfile } from '../src/data/profile';
import { createSet } from '../src/data/sets';
import {
  addDocumentToSet,
  extendPlanForDocument,
  planSet,
  type FileSource,
} from '../src/data/pipeline';
import { extractHeadings } from '../src/ai/gemini';

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
  const { setId: existingSetId } = useLocalSearchParams<{ setId?: string }>();
  const addingToExisting = typeof existingSetId === 'string' && existingSetId.length > 0;
  const t = useTheme();
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });

  const [text, setText] = useState('');
  const [file, setFile] = useState<{ blob: Blob; name: string; mime: string } | null>(null);
  const [title, setTitle] = useState('');
  const [count, setCount] = useState<number>(20);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <Title>{addingToExisting ? 'Add notes' : 'New set'}</Title>

      <Card>
        <Body>Paste your notes</Body>
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
            fontSize: 15,
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
