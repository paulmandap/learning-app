import { useState } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Field, Notice, Screen, TopBar } from '../src/ui/components';
import { TextLink } from '../src/ui/legal';
import { type, useTheme } from '../src/ui/theme';
import { fetchProfile, saveDisplayName } from '../src/data/profile';
import { BiosUnavailableError, fetchMyBio, fetchMyUsername, saveBio, saveUsername } from '../src/data/social';
import { BIO_MAX } from '../src/core/profile';
import { USERNAME_MAX } from '../src/core/social';

/**
 * Edit profile (NOTES §59): your name, your username and your bio, in one
 * place, from the button under your picture — the owner's picture has it
 * there. Your picture itself stays in Settings, where the faces and your
 * uploaded photos already are; a link goes there.
 *
 * Only what changed is saved, one thing after another, and a refusal says
 * which: a taken username should not lose the bio typed beside it.
 */
export default function EditProfile() {
  const t = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const username = useQuery({ queryKey: ['my-username'], queryFn: () => fetchMyUsername() });
  const bio = useQuery({ queryKey: ['my-bio'], queryFn: () => fetchMyBio(), retry: false });
  const biosOff = bio.error instanceof BiosUnavailableError;

  const [name, setName] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [about, setAbout] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const shownName = name ?? profile.data?.display_name ?? '';
  const shownHandle = handle ?? username.data ?? '';
  const shownBio = about ?? bio.data ?? '';

  const save = useMutation({
    mutationFn: async () => {
      if (name !== null && name.trim() !== (profile.data?.display_name ?? '')) await saveDisplayName(name);
      if (handle !== null && handle.trim() !== (username.data ?? '')) await saveUsername(handle);
      if (about !== null && about.trim() !== (bio.data ?? '')) await saveBio(about);
    },
    onSuccess: async () => {
      setName(null);
      setHandle(null);
      setAbout(null);
      setSaved(true);
      for (const key of ['profile', 'my-username', 'my-bio', 'nomi-brain']) {
        await queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  const changed = name !== null || handle !== null || about !== null;

  return (
    <Screen>
      <TopBar title="Edit profile" />
      <Field
        label="Name"
        value={shownName}
        onChangeText={(v) => {
          setName(v);
          setSaved(false);
        }}
        placeholder="What should people call you?"
        autoCapitalize="sentences"
        maxLength={60}
      />
      <Field
        label="Username"
        value={shownHandle}
        onChangeText={(v) => {
          setHandle(v);
          setSaved(false);
        }}
        placeholder="yourname"
        maxLength={USERNAME_MAX + 1}
      />
      <Body muted>Friends find you by your username. Letters, numbers and _, starting with a letter.</Body>

      {biosOff ? (
        <Body muted>Bios aren&apos;t switched on yet.</Body>
      ) : (
        <>
          <Field
            label="Bio"
            value={shownBio}
            onChangeText={(v) => {
              setAbout(v);
              setSaved(false);
            }}
            placeholder="A line about you — what you study, what you're working towards"
            autoCapitalize="sentences"
            maxLength={BIO_MAX}
          />
          <Text style={[type.caption, { color: t.textMuted, textAlign: 'right' }]}>{`${shownBio.length}/${BIO_MAX}`}</Text>
          <Body muted>Anyone signed in to Nomi can see your bio, on your page.</Body>
        </>
      )}

      {save.isError ? <Notice tone="error">{(save.error as Error).message}</Notice> : null}
      {saved ? <Notice tone="ok">Saved.</Notice> : null}
      <Button label="Save" onPress={() => save.mutate()} busy={save.isPending} disabled={!changed} />
      <TextLink label="Change your picture in Settings" onPress={() => router.push('/settings')} />
    </Screen>
  );
}
