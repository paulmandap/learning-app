import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { startSessionListener, useSessionStore } from '../src/data/session';
import { HeaderBackButton, HeaderGlyphButton } from '../src/ui/menu';
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

/**
 * Every screen that is not the root gets an EXPLICIT back control.
 *
 * The stack's built-in chevron only renders when the navigator has a previous
 * entry, and two ordinary paths through this app produce a screen without one:
 * creating a set lands via `router.replace` (so back cannot return you to the
 * half-filled form), and reloading or reopening the installed PWA on a deep URL
 * rebuilds the stack with a single screen. An installed iOS PWA has no
 * edge-swipe-back either, so a missing chevron is a dead end rather than a
 * cosmetic gap. HeaderBackButton falls back to Home when there is no history.
 *
 * headerBackVisible: false stops the built-in chevron rendering alongside ours
 * on the occasions when the stack does have somewhere to go.
 */
const backable = {
  headerBackVisible: false,
  headerLeft: () => <HeaderBackButton />,
} as const;

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
        <Stack.Screen name="settings" options={{ title: 'Settings', ...backable }} />
        <Stack.Screen name="new" options={{ title: 'New set', ...backable }} />
        {/* Title is set by the screen itself, to the set's own name. */}
        <Stack.Screen name="set/[id]/index" options={{ title: '', ...backable }} />
        <Stack.Screen name="set/[id]/flashcards" options={{ title: 'Flashcards', ...backable }} />
        <Stack.Screen name="set/[id]/quiz" options={{ title: 'Quiz', ...backable }} />
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
