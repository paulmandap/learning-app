import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { startSessionListener, useSessionStore } from '../src/data/session';
import { HeaderGlyphButton } from '../src/ui/menu';
import { useTheme } from '../src/ui/theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

/** Sends signed-out users to sign-in, and signed-in users away from it. */
function useAuthRedirect() {
  const session = useSessionStore((s) => s.session);
  const ready = useSessionStore((s) => s.ready);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const onSignIn = segments[0] === 'sign-in';
    if (!session && !onSignIn) router.replace('/sign-in');
    if (session && onSignIn) router.replace('/');
  }, [ready, session, segments, router]);
}

function RootNavigator() {
  const t = useTheme();
  const router = useRouter();
  useAuthRedirect();

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.card },
          headerTitleStyle: { color: t.text },
          headerTintColor: t.accent,
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        {/* Global navigation lives HERE, in the header — not as buttons in the
            scroll view mixed among content actions. The gear is the only way to
            Settings, and Sign out lives inside Settings rather than on Home. */}
        <Stack.Screen
          name="index"
          options={{
            title: 'Study',
            headerRight: () => (
              <HeaderGlyphButton
                glyph="⚙︎"
                accessibilityLabel="Settings"
                onPress={() => router.push('/settings')}
              />
            ),
          }}
        />
        <Stack.Screen name="sign-in" options={{ title: 'Sign in', headerShown: false }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="new" options={{ title: 'New set' }} />
        {/* Title is set by the screen itself, to the set's own name. */}
        <Stack.Screen name="set/[id]/index" options={{ title: '' }} />
        <Stack.Screen name="set/[id]/flashcards" options={{ title: 'Flashcards' }} />
        <Stack.Screen name="set/[id]/quiz" options={{ title: 'Quiz' }} />
      </Stack>
    </View>
  );
}

export default function RootLayout() {
  const scheme = useColorScheme();

  useEffect(() => startSessionListener(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <RootNavigator />
    </QueryClientProvider>
  );
}
