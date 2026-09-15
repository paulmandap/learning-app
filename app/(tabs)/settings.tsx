import { useEffect, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, Field, Label, Notice, Screen, Title } from '../../src/ui/components';
import {
  avatarPhotoUrls,
  AvatarsUnavailableError,
  fetchProfile,
  listAvatarPhotos,
  saveAvatar,
  saveDisplayName,
  saveGeminiKey,
  savePetChoice,
  uploadAvatarPhoto,
} from '../../src/data/profile';
import { Avatar, FacePicker, PhotoPicker, pickProfilePhoto } from '../../src/ui/avatar';
import { PrivacyNotice } from '../../src/ui/privacy';
import { TextLink } from '../../src/ui/legal';
import { forgetAvatar } from '../../src/data/avatar-cache';
import { router } from 'expo-router';
import { parseAvatar } from '../../src/core/avatar';
import { useSessionStore } from '../../src/data/session';
import { space, TOUCH_TARGET, type, useTheme } from '../../src/ui/theme';
import { PetChooser } from '../../src/ui/pet';
import { RemindersCard } from '../../src/ui/reminders';
import { forgetThisDevice } from '../../src/data/reminders';
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

/**
 * Settings, in the owner's order (NOTES §37): you, your pet, your key, how to
 * get one, your account, and deleting your data last.
 *
 * "Where your notes go" is no longer a card here. It became a notice shown once
 * after signing in (`src/ui/privacy.tsx`), and "Privacy" under Your account
 * opens the same words again.
 */
export default function Settings() {
  const t = useTheme();
  const queryClient = useQueryClient();
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });

  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState<string | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);

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

  // Every photo they have uploaded, offered beside the faces (NOTES §45).
  const { data: photos = [] } = useQuery({
    queryKey: ['avatar-photos', profile?.avatar ?? null],
    queryFn: () => listAvatarPhotos(profile?.avatar ?? null),
    enabled: !!profile,
  });
  const { data: photoLinks = {} } = useQuery({
    queryKey: ['avatar-photo-links', photos],
    queryFn: () => avatarPhotoUrls(photos),
    enabled: photos.length > 0,
    // The links last an hour; refresh well before they lapse.
    staleTime: 50 * 60 * 1000,
  });

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

  /**
   * What to say when a picture will not save — and the real reason, logged.
   *
   * The screen said "try again in a moment" for every failure, and the one the
   * owner hit could never be fixed by waiting: the column did not exist yet
   * (NOTES §37). The sentence stays plain; the console now says why.
   */
  function describeAvatarError(err: unknown): string {
    console.warn(`[settings] picture not saved: ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof AvatarsUnavailableError
      ? "Choosing a picture isn't switched on yet."
      : "Couldn't save that picture just now. Try again in a moment.";
  }

  /** A face or one of their photos. */
  async function choosePicture(value: string) {
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
      await uploadAvatarPhoto(image);
      await queryClient.invalidateQueries({ queryKey: ['profile'] });
      await queryClient.invalidateQueries({ queryKey: ['avatar-photos'] });
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
        {photos.length > 0 ? (
          <>
            <Label>Your photos</Label>
            <PhotoPicker
              photos={photos}
              links={photoLinks}
              selected={avatar.kind === 'photo' ? avatar.path : null}
              onPick={choosePicture}
              disabled={!profile || avatarBusy}
            />
          </>
        ) : null}
        <Label>Pick a face</Label>
        <FacePicker
          selected={avatar.kind === 'face' && avatar.chosen ? avatar.index : null}
          onPick={choosePicture}
          disabled={!profile || avatarBusy}
        />
        <Button label="Use a photo" variant="secondary" onPress={uploadPhoto} busy={avatarBusy} />
        {avatarError ? <Notice tone="error">{avatarError}</Notice> : null}
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

      {/* --------------------------------------------------- reminders -- */}
      {/* Up to three a day, saying what's due (NOTES §45). */}
      <RemindersCard />

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
            // The picture kept on this device leaves with the session, so a
            // shared phone does not hold someone's photo after they go (NOTES §40).
            forgetAvatar(userId);
            // This device stops getting reminders first: removing it needs
            // the session, and the next person on the phone must not be shown
            // someone else's due cards (NOTES §45).
            void forgetThisDevice().finally(() => supabase.auth.signOut());
          }}
        />
        {/* The privacy notice, to read again. It was shown once after signing
            in; this is where to find it after that (NOTES §37). */}
        <Pressable
          accessibilityRole="button"
          onPress={() => setPrivacyOpen(true)}
          hitSlop={8}
          style={{ minHeight: TOUCH_TARGET, justifyContent: 'center' }}
        >
          <Text style={[type.label, { color: t.accent }]}>Privacy: where your notes go</Text>
        </Pressable>
        {/* The full documents; the notice above is their short version (NOTES §40). */}
        <TextLink label="Privacy Policy" onPress={() => router.push('/privacy')} />
        <TextLink label="Terms of Use" onPress={() => router.push('/terms')} />
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

      <PrivacyNotice visible={privacyOpen} onClose={() => setPrivacyOpen(false)} />
    </Screen>
  );
}
