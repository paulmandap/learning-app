import { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, Field, Label, Notice, Screen, Title } from '../../src/ui/components';
import {
  AvatarsUnavailableError,
  fetchProfile,
  saveAvatar,
  saveDisplayName,
  saveGeminiKey,
  savePetChoice,
  uploadAvatarPhoto,
} from '../../src/data/profile';
import { Avatar, FacePicker, pickProfilePhoto } from '../../src/ui/avatar';
import { parseAvatar } from '../../src/core/avatar';
import { useSessionStore } from '../../src/data/session';
import { space } from '../../src/ui/theme';
import { PetChooser } from '../../src/ui/pet';
import { toPetSpecies, type PetSpecies } from '../../src/core/pet';
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

  /**
   * The pet, held locally while the save is in flight.
   *
   * Without this the tile does not light up until the round trip comes back,
   * which on a phone reads as a tap that did nothing. `pending` wins over the
   * stored value only until the refetch lands, and a failed save clears it —
   * so a pet that could not be saved goes back to the one that is real rather
   * than lying about what is stored.
   */
  const [pendingPet, setPendingPet] = useState<PetSpecies | null>(null);
  const [petError, setPetError] = useState<string | null>(null);
  const pet = pendingPet ?? toPetSpecies(profile?.pet);

  // --- you: the name Home greets, and the picture beside it (NOTES §36) ---
  const userId = useSessionStore((s) => s.session?.user.id) ?? '';
  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatar = parseAvatar(profile?.avatar, userId);

  useEffect(() => {
    if (profile?.display_name) setName(profile.display_name);
  }, [profile?.display_name]);

  async function saveName() {
    setSavingName(true);
    setNameSaved(false);
    try {
      await saveDisplayName(name);
      await queryClient.invalidateQueries({ queryKey: ['profile'] });
      await queryClient.invalidateQueries({ queryKey: ['nomi-brain'] });
      setNameSaved(true);
    } catch {
      setAvatarError("Couldn't save your name just now. Try again in a moment.");
    } finally {
      setSavingName(false);
    }
  }

  function describeAvatarError(err: unknown): string {
    return err instanceof AvatarsUnavailableError
      ? "Choosing a picture isn't switched on yet."
      : "Couldn't save that picture just now. Try again in a moment.";
  }

  async function chooseFace(value: string) {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      await saveAvatar(value);
      await queryClient.invalidateQueries({ queryKey: ['profile'] });
    } catch (err) {
      setAvatarError(describeAvatarError(err));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function uploadPhoto() {
    setAvatarError(null);
    try {
      const image = await pickProfilePhoto();
      if (!image) return;
      setAvatarBusy(true);
      await uploadAvatarPhoto(image, profile?.avatar ?? null);
      await queryClient.invalidateQueries({ queryKey: ['profile'] });
    } catch (err) {
      setAvatarError(describeAvatarError(err));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function choosePet(next: PetSpecies) {
    setPendingPet(next);
    setPetError(null);
    try {
      await savePetChoice(next);
      await queryClient.invalidateQueries({ queryKey: ['profile'] });
    } catch {
      setPendingPet(null);
      setPetError("Couldn't save that just now. Try again in a moment.");
    }
  }

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

      {/* ------------------------------------------------------------ you -- */}
      {/* First, because it is the one card here about the person rather than
          the app: the name Home greets them by and the picture in its corner. */}
      <Card>
        <Body>You</Body>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
          <Avatar value={profile?.avatar} userId={userId} size={72} />
          <View style={{ flex: 1 }}>
            <Body muted>This is you on Home. Pick a face, or use a photo.</Body>
          </View>
        </View>
        <Field
          label="Your name"
          value={name}
          onChangeText={(v) => {
            setName(v);
            setNameSaved(false);
          }}
          placeholder="What should Nomi call you?"
          autoCapitalize="sentences"
          maxLength={60}
          onSubmitEditing={saveName}
        />
        <Button label="Save name" variant="secondary" onPress={saveName} busy={savingName} />
        {nameSaved ? <Notice tone="ok">Saved.</Notice> : null}
        <Label>Pick a face</Label>
        <FacePicker
          selected={avatar.kind === 'face' && avatar.chosen ? avatar.index : null}
          onPick={chooseFace}
          disabled={!profile || avatarBusy}
        />
        <Button label="Use a photo" variant="secondary" onPress={uploadPhoto} busy={avatarBusy} />
        {avatarError ? <Notice tone="error">{avatarError}</Notice> : null}
      </Card>

      {/* ------------------------------------------------ privacy notice -- */}
      {/* Visible immediately, next to the key field — never behind a tap or a
          link. The "a real person at Google may read them" sentence is the one
          users are least likely to assume; it must not be trimmed away.

          INFO, not warn. It is information the student needs, not an alarm
          about something going wrong, and three paragraphs of warning amber
          as the first thing on the screen outshouted the real warnings below
          it (NOTES §35). Re-toned only: D13's wording is untouched, and
          tests/screens.test.ts still pins it. */}
      <Card>
        <Body>Where your notes go</Body>
        <Notice tone="info">
          When you make cards, your notes are sent to Google using your own free key. The key is
          free, so Google may keep your notes to help improve its products — and a real person at
          Google may read them.{'\n\n'}
          Please don't add patient information, anyone's personal details, or confidential work
          documents. A good test: if you wouldn't want a stranger reading it, don't put it here.
          {'\n\n'}
          {/* D13 fixes this copy and says it must not be paraphrased smaller,
              so the assistant is NAMED here rather than left implied — it sends
              notes to Google more often, and more casually, than making cards
              does. Wording approved by the owner (Phase 9c), and EXTENDED with
              his approval on 2026-09-13 when the assistant began sending what it
              knows about the student's studying with each message (NOTES §36).
              The companion's name stays out of this paragraph, comments
              included — tests/screens.test.ts reads the whole block. */}
          The study assistant works the same way — what you ask it, the notes it looks at, and
          what it knows about your studying (your name, sets, streak and progress) are sent to
          Google too.
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

      {/* ----------------------------------------------------- your pet -- */}
      <Card>
        <Body>Your study pet</Body>
        <Body muted>
          It grows the longer you keep your streak going. Pick the one you'd rather see.
        </Body>
        <PetChooser value={pet} onChange={choosePet} disabled={!profile} />
        {petError ? <Notice tone="error">{petError}</Notice> : null}
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
