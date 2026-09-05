import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, Field, Notice, Screen, Title } from '../../src/ui/components';
import { fetchProfile, saveGeminiKey } from '../../src/data/profile';
import { deleteAllMyData } from '../../src/data/sets';
import { supabase } from '../../src/data/supabase';
import { GeminiBrowserProvider } from '../../src/ai/gemini';
import { reasonToMessage } from '../../src/core/ai-errors';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; count: number }
  | { kind: 'error'; message: string };

export default function Settings() {
  const queryClient = useQueryClient();
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });

  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState<string | null>(null);

  async function reallyDelete() {
    setDeleting(true);
    try {
      const { setsDeleted } = await deleteAllMyData();
      setDeleted(
        setsDeleted === 0
          ? 'Nothing left to delete.'
          : `Deleted ${setsDeleted} set${setsDeleted === 1 ? '' : 's'} and everything in them.`,
      );
      setConfirmDelete(false);
      setKey('');
      await queryClient.invalidateQueries();
    } catch {
      setDeleted('Something went wrong. Some data may not have been deleted.');
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    if (profile?.gemini_api_key) setKey(profile.gemini_api_key);
  }, [profile?.gemini_api_key]);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await saveGeminiKey(key.trim() ? key.trim() : null);
      await queryClient.invalidateQueries({ queryKey: ['profile'] });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    const candidate = key.trim();
    if (!candidate) {
      setTest({ kind: 'error', message: 'Add your key first.' });
      return;
    }
    setTest({ kind: 'testing' });
    const provider = new GeminiBrowserProvider(candidate);
    const result = await provider.testConnection();
    setTest(
      result.ok
        ? { kind: 'ok', count: result.models.length }
        : { kind: 'error', message: reasonToMessage(result.reason) },
    );
  }

  return (
    <Screen>
      <Title>Settings</Title>

      {/* ------------------------------------------------ privacy notice -- */}
      {/* Visible immediately, next to the key field — never behind a tap or a
          link. The "a real person at Google may read them" sentence is the one
          users are least likely to assume; it must not be trimmed away. */}
      <Card>
        <Body>Where your notes go</Body>
        <Notice tone="warn">
          When you make cards, your notes are sent to Google using your own free key. The key is
          free, so Google may keep your notes to help improve its products — and a real person at
          Google may read them.{'\n\n'}
          Please don't add patient information, anyone's personal details, or confidential work
          documents. A good test: if you wouldn't want a stranger reading it, don't put it here.
          {'\n\n'}
          {/* D13 fixes this copy and says it must not be paraphrased smaller,
              so the assistant is NAMED here rather than left implied — it sends
              notes to Google more often, and more casually, than making cards
              does. Wording approved by the owner (Phase 9c). */}
          The study assistant works the same way — what you ask it, and the notes it looks at to
          answer, are sent to Google too.
        </Notice>
      </Card>

      {/* ---------------------------------------------------- key + test -- */}
      <Card>
        <Body>Your Gemini key</Body>
        <Field
          label="Key"
          value={key}
          onChangeText={(v) => {
            setKey(v);
            setSaved(false);
            setTest({ kind: 'idle' });
          }}
          placeholder="Paste your key here"
          secure
        />
        <Body muted>
          Your key is saved to your account, so it works on your phone and your laptop. Only you can
          see it.
        </Body>
        <Button label="Save key" onPress={save} busy={saving} />
        <Button label="Test connection" variant="secondary" onPress={runTest} />

        {saved ? <Notice tone="ok">Saved.</Notice> : null}
        {test.kind === 'testing' ? <Notice tone="warn">Checking…</Notice> : null}
        {test.kind === 'ok' ? (
          <Notice tone="ok">Your key works. Google offered {test.count} ways to make cards.</Notice>
        ) : null}
        {test.kind === 'error' ? <Notice tone="error">{test.message}</Notice> : null}
      </Card>

      {/* --------------------------------------------------------- guide -- */}
      <Card>
        <Body>How to get a key</Body>
        <Body muted>
          1. Open Google AI Studio and sign in with your Google account.{'\n'}
          2. Choose "Get API key", then "Create API key".{'\n'}
          3. Copy the key and paste it above, then choose Save key.{'\n'}
          4. Choose Test connection to check it works.
        </Body>
        <Button
          label="Open Google AI Studio"
          variant="secondary"
          onPress={() => {
            void Linking.openURL('https://aistudio.google.com/apikey');
          }}
        />
        <Body muted>
          On an iPhone, add this app to your Home Screen from the Share menu to use it like an app.
        </Body>
      </Card>

      {/* ------------------------------------------------------ account -- */}
      <Card>
        <Body>Your account</Body>
        <Body muted>Theme follows your device setting.</Body>
        <Button
          label="Sign out"
          variant="secondary"
          onPress={() => {
            void supabase.auth.signOut();
          }}
        />
      </Card>

      {/* Deleting is irreversible, so it asks once rather than acting on the
          first tap. Two taps is the right amount of friction here. */}
      <Card>
        <Body>Delete my data</Body>
        <Body muted>
          Removes every set, all your notes and files, and everything you've answered. Your
          key is cleared too. This cannot be undone.
        </Body>
        {confirmDelete ? (
          <>
            <Notice tone="error">Really delete everything? This cannot be undone.</Notice>
            <Button label="Yes, delete everything" onPress={reallyDelete} busy={deleting} />
            <Button
              label="Keep my data"
              variant="secondary"
              onPress={() => setConfirmDelete(false)}
            />
          </>
        ) : (
          <Button
            label="Delete my data"
            variant="secondary"
            onPress={() => setConfirmDelete(true)}
          />
        )}
        {deleted ? <Notice tone="ok">{deleted}</Notice> : null}
      </Card>
    </Screen>
  );
}
