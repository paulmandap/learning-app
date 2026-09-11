import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { startSessionListener, useSessionStore } from '../src/data/session';
import { HeaderBackButton } from '../src/ui/menu';
import { StudyAssistant } from '../src/ui/assistant';
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
  const segments = useSegments();
  useAuthRedirect();

  // Mounted once, above the navigator, so it survives navigation and keeps its
  // panel open across screens. Hidden on sign-in: there are no notes to ask
  // about yet, and a floating button over a one-field form is clutter.
  const showAssistant = segments[0] !== 'sign-in';

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
        {/* Global navigation lives in app/(tabs)/_layout.tsx now — Study,
            Progress and Settings, as a bottom bar on a phone and a rail on a
            desktop (spec §2). It draws its own chrome, so the stack header is
            hidden for the whole group.

            What stays OUT of the tabs is deliberate: everything below is a
            TASK with its own back control, not a place you navigate to. A
            flashcard session covering the bar is the point — offering two ways
            out mid-deck is a distraction rather than an option. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ title: 'Sign in', headerShown: false }} />
        <Stack.Screen name="new" options={{ title: 'New set', ...backable }} />
        {/* A note is a TASK with its own back control, so it is pushed above
            the tabs rather than being one — same rule as a flashcard session.
            Registered explicitly, or the header reads "note/[id]" to the user,
            which is exactly what shipped once for set/[id]/blanks. */}
        <Stack.Screen name="note/[id]" options={{ title: 'Note', ...backable }} />
        {/* Title is set by the screen itself, to the set's own name. */}
        <Stack.Screen name="set/[id]/index" options={{ title: '', ...backable }} />
        <Stack.Screen name="set/[id]/flashcards" options={{ title: 'Flashcards', ...backable }} />
        <Stack.Screen name="set/[id]/quiz" options={{ title: 'Quiz', ...backable }} />
        {/* Without this the header falls back to the route pattern and reads
            "set/[id]/blanks" to the user. */}
        <Stack.Screen
          name="set/[id]/blanks"
          options={{ title: 'Fill in the blanks', ...backable }}
        />
        {/* Registered for the same reason as the routes above: without it the
            header reads "+not-found". `backable` matters more here than
            anywhere else — the usual way to reach this screen is a deep link
            into a stack with no history, and HeaderBackButton is what turns
            that into a way out rather than a dead end. */}
        <Stack.Screen name="+not-found" options={{ title: 'Not found', ...backable }} />
      </Stack>
      {showAssistant ? <StudyAssistant /> : null}
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
