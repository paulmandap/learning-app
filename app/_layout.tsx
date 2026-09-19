import { useEffect, useRef } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform, useColorScheme, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { startSessionListener, useSessionStore } from '../src/data/session';
import { HeaderBackButton } from '../src/ui/menu';
import { StudyAssistant } from '../src/ui/assistant';
import { PrivacyGate } from '../src/ui/privacy';
import { useTheme } from '../src/ui/theme';
import { shouldHideSplash, SPLASH_MIN_MS } from '../src/core/splash';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

/**
 * The Terms of Use and the Privacy Policy (NOTES §40). Readable by anyone:
 * the sign-in screen links to them, and asking someone to sign in before they
 * can read what they are agreeing to would be backwards.
 */
function isPublicRoute(segment: string | undefined): boolean {
  return segment === 'terms' || segment === 'privacy';
}

/** Sends signed-out users to sign-in, and signed-in users away from it. */
function useAuthRedirect() {
  const session = useSessionStore((s) => s.session);
  const ready = useSessionStore((s) => s.ready);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const onSignIn = segments[0] === 'sign-in';
    if (!session && !onSignIn && !isPublicRoute(segments[0])) router.replace('/sign-in');
    if (session && onSignIn) router.replace('/');
  }, [ready, session, segments, router]);
}

/**
 * Everything cached belongs to whoever was signed in when it was fetched
 * (NOTES §42), so a change of person resets it.
 *
 * Found chasing the owner's report that the privacy notice flashed for a
 * moment after entering the sign-in code. The app opens at Home, and in the
 * instant before the redirect to sign-in the assistant asked for the profile
 * with nobody signed in. Row-level security answered with no row, and that
 * empty profile stayed in the cache — so on signing in the notice read "not
 * accepted" and opened, until a background refetch found the real profile and
 * closed it. The same cache would have shown one person's data to the next on a
 * shared phone. Token refreshes keep the same person, and keep the cache.
 */
function useResetCacheOnUserChange() {
  const userId = useSessionStore((s) => s.session?.user.id ?? null);
  const previous = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (previous.current !== undefined && previous.current !== userId) void queryClient.resetQueries();
    previous.current = userId;
  }, [userId]);
}

/**
 * Fade out the splash in `public/index.html` (NOTES §42) once the first screen
 * is ready behind it (§45): the app knows whether anyone is signed in — so it
 * is never sign-in flashing before Home — and the screen has the data it asked
 * for, so what the splash reveals is the screen, not "Loading…".
 * `shouldHideSplash` decides; this only watches.
 */
function useHideSplash() {
  const ready = useSessionStore((s) => s.ready);

  useEffect(() => {
    if (!ready || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const splash = document.getElementById('splash');
    if (!splash) return;
    const clock = () => (typeof performance === 'undefined' ? Date.now() : performance.now());
    const readyAt = clock();
    let idleSince: number | null = null;
    let sawWork = false;
    // A check every 50ms for the second or two the splash is up — simpler than
    // following every query's events, and it stops the moment the splash goes.
    const watch = setInterval(() => {
      const at = clock();
      const fetching = queryClient.isFetching();
      if (fetching > 0) {
        sawWork = true;
        idleSince = null;
      } else if (idleSince === null) {
        idleSince = at;
      }
      const hide = shouldHideSplash({
        sinceLoad: typeof performance === 'undefined' ? SPLASH_MIN_MS : at,
        sinceReady: at - readyAt,
        signedIn: !!useSessionStore.getState().session,
        fetching,
        idleFor: idleSince === null ? 0 : at - idleSince,
        sawWork,
      });
      if (!hide) return;
      clearInterval(watch);
      splash.classList.add('gone');
      // After the 280ms fade in index.html; gone from the page, not merely invisible.
      setTimeout(() => splash.remove(), 320);
    }, 50);
    return () => clearInterval(watch);
  }, [ready]);
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
  const signedIn = useSessionStore((s) => !!s.session);
  useAuthRedirect();
  useResetCacheOnUserChange();
  useHideSplash();

  // Mounted once, above the navigator, so it survives navigation and keeps its
  // panel open across screens. Hidden on sign-in: there are no notes to ask
  // about yet, and a floating button over a one-field form is clutter. Hidden
  // on Nomi's own screen too, where the whole screen is the conversation it
  // would open (NOTES §36), and over the two legal documents, which may be
  // read before signing in (NOTES §40). And never mounted signed out: it loads
  // the profile as it mounts, which is how an empty one reached the cache
  // before the first redirect to sign-in (NOTES §42).
  //
  // Hidden on Community for the Nomi-screen reason and one more (NOTES §47):
  // the owner, on a phone — *"the gemini icon or chatbot is interfering with
  // the send button. it looks messy."* The ✦ floats bottom-right and so does a
  // chat's Send, so they land on each other. Every other screen is a `Screen`,
  // which reserves FLOAT_CLEARANCE below its content; the chat cannot, because
  // its composer is pinned rather than scrolled.
  //
  // The whole tab rather than the chat pane alone, because the panes are
  // component state and not routes, so nothing here can see which one is open.
  // Little is lost: Community is where OTHER people are, Nomi is one tap away
  // in its own tab, and there is nothing on a stranger's set to ask Nomi about
  // — it cannot read their notes (NOTES §46).
  //
  // `path`, not `segments[1]`. `useSegments()` is typed from the route types
  // the dev server generates into `.expo/types/`, which is gitignored — so on
  // THIS machine it is a union deep enough to index, and on a clean checkout it
  // is `[string]`, where `segments[1]` is TS2493 and the build fails. That is a
  // typecheck error only CI can see, which is the worst kind: it passed here,
  // passed review, and broke the first run after the push (NOTES §47.8).
  const path = segments as readonly string[];
  const showAssistant =
    signedIn &&
    path[0] !== 'sign-in' &&
    path[0] !== 'nomi' &&
    path[1] !== 'community' &&
    !isPublicRoute(segments[0]);

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
        {/* Global navigation lives in app/(tabs)/_layout.tsx now — Nomi (the
            tab that was Study, NOTES §40), Notes, Progress and Settings, as a
            bottom bar on a phone and a rail on a desktop (spec §2). It draws its
            own chrome, so the stack header is hidden for the whole group.

            What stays OUT of the tabs is deliberate: everything below is a
            TASK with its own back control, not a place you navigate to. A
            flashcard session covering the bar is the point — offering two ways
            out mid-deck is a distraction rather than an option. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ title: 'Sign in', headerShown: false }} />
        {/* title: '' on every screen that renders its own heading.
            Four screens set a stack title AND drew the same words again in the
            body, so "Quiz" appeared twice, one above the other. The pattern was
            already solved for set/[id]/index — a long set name collided with
            the back control, so its stack title was blanked and the screen
            names itself. It was simply never applied to the rest.
            NOTES §35. */}
        <Stack.Screen name="new" options={{ title: '', ...backable }} />
        {/* Nomi is reached from the heading of the first tab and Progress, not
            from the tab bar. The four tabs are the learning loop, and a fifth
            for a companion would make Nomi somewhere you go INSTEAD of studying
            rather than something that sits beside it. Pushed above the tabs
            with a back control, like every other task route. */}
        <Stack.Screen name="nomi" options={{ title: 'Nomi', ...backable }} />
        {/* A note is a TASK with its own back control, so it is pushed above
            the tabs rather than being one — same rule as a flashcard session.
            Registered explicitly, or the header reads "note/[id]" to the user,
            which is exactly what shipped once for set/[id]/blanks. */}
        <Stack.Screen name="note/[id]" options={{ title: 'Note', ...backable }} />
        {/* Title is set by the screen itself, to the set's own name. */}
        <Stack.Screen name="set/[id]/index" options={{ title: '', ...backable }} />
        <Stack.Screen name="set/[id]/flashcards" options={{ title: '', ...backable }} />
        <Stack.Screen name="set/[id]/quiz" options={{ title: '', ...backable }} />
        {/* Without this the header falls back to the route pattern and reads
            "set/[id]/blanks" to the user. */}
        <Stack.Screen
          name="set/[id]/blanks"
          options={{ title: '', ...backable }}
        />
        {/* Each document names itself in its body. */}
        <Stack.Screen name="terms" options={{ title: '', ...backable }} />
        <Stack.Screen name="privacy" options={{ title: '', ...backable }} />
        {/* Registered for the same reason as the routes above: without it the
            header reads "+not-found". `backable` matters more here than
            anywhere else — the usual way to reach this screen is a deep link
            into a stack with no history, and HeaderBackButton is what turns
            that into a way out rather than a dead end. */}
        <Stack.Screen name="+not-found" options={{ title: 'Not found', ...backable }} />
      </Stack>
      {showAssistant ? <StudyAssistant /> : null}
      {/* D13's notice, read once before anything is sent (NOTES §37). It moved
          here from a card on Settings, at the owner's request. */}
      <PrivacyGate />
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
