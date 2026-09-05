import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { startSessionListener, useSessionStore } from '../src/data/session';
import { HeaderBackButton, HeaderGlyphButton, HeaderTitle } from '../src/ui/menu';
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
          // The header takes the PAGE background, not the card surface, and
          // drops its hairline.
          //
          // As a distinct bar it spanned the whole window while its two controls
          // sat at the content column's edges, so a lone chevron floated in a
          // wide empty strip and read as a rendering fault. With no bar there is
          // nothing demanding to be filled: the chevron and the ⋯ simply sit
          // above the content, aligned to it, the way an iOS large-title screen
          // works before you scroll.
          headerStyle: { backgroundColor: t.bg },
          headerShadowVisible: false,
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
            // Home has no back control, so its title needs the same inset the
            // gear gets — otherwise the header is aligned on the right and not
            // the left. Every other screen has a chevron, and the title is laid
            // out after it, so it inherits the alignment for free.
            headerTitle: () => <HeaderTitle>Study</HeaderTitle>,
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
