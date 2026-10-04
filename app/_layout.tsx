import { useEffect, useRef } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform, useColorScheme, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { startSessionListener, useSessionStore } from '../src/data/session';
import { forgetSavedScreens, keepSavingScreens, restoreSavedScreens } from '../src/data/saved-screens';
import { keepBrowserMenusAway } from '../src/ui/app-feel';
import { HeaderBackButton } from '../src/ui/menu';
import { StudyAssistant } from '../src/ui/assistant';
import { PrivacyGate } from '../src/ui/privacy';
import { RulesSheet, StandingNotice } from '../src/ui/rules';
import { useTheme } from '../src/ui/theme';
import { holdsSplash, shouldHideSplash, SPLASH_MIN_MS } from '../src/core/splash';
import { KEPT_SCREENS, KEPT_SCREENS_GC_MS } from '../src/core/saved-screens';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

// What this device keeps (NOTES §71) stays in memory a day rather than five
// minutes, so a screen nobody opened since launch is still there to be kept.
for (const root of KEPT_SCREENS) queryClient.setQueryDefaults([root], { gcTime: KEPT_SCREENS_GC_MS });

/**
 * The Terms of Use and the Privacy Policy (NOTES §40). Readable by anyone:
 * the sign-in screen links to them, and asking someone to sign in before they
 * can read what they are agreeing to would be backwards.
 */
function isPublicRoute(segment: string | undefined): boolean {
  // And the community rules (NOTES §55): how people are expected to treat
  // each other is worth reading before deciding to join.
  return segment === 'terms' || segment === 'privacy' || segment === 'rules';
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
 *
 * Counted from the first answer about who is signed in, not from before it
 * (NOTES §71). Before, "nobody yet" turning into the person already signed in
 * counted as a change: every open reset the cache the moment it began, and the
 * reset asked again for everything Home had just asked for — 34 requests where
 * 17 were needed, measured on 2026-10-04. It would now also throw away the copy
 * just put back from this device. A real change of person removes that copy.
 */
function useResetCacheOnUserChange() {
  const ready = useSessionStore((s) => s.ready);
  const userId = useSessionStore((s) => s.session?.user.id ?? null);
  const previous = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!ready) return;
    if (previous.current !== undefined && previous.current !== userId) {
      forgetSavedScreens();
      void queryClient.resetQueries();
    }
    previous.current = userId;
  }, [ready, userId]);
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
      // Only requests the screen is waiting on (NOTES §71): what was put back
      // from this device is already drawn, and its refresh happens in view.
      const fetching = queryClient.isFetching({
        predicate: (query) => holdsSplash(query.queryKey, query.state.data !== undefined),
      });
      if (queryClient.isFetching() > 0) sawWork = true;
      if (fetching > 0) {
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

/** Where the floating ✦ is: a set's three study screens, and nowhere else (NOTES §65). */
const ASSISTANT_SCREENS: readonly string[] = ['flashcards', 'quiz', 'blanks'];

function RootNavigator() {
  const t = useTheme();
  const segments = useSegments();
  const signedIn = useSessionStore((s) => !!s.session);
  useAuthRedirect();
  useResetCacheOnUserChange();
  useHideSplash();

  // Mounted once, above the navigator, so it survives navigation and keeps its
  // panel open across screens. Never mounted signed out: it loads the profile
  // as it mounts, which is how an empty one reached the cache before the first
  // redirect to sign-in (NOTES §42).
  //
  // ONLY on the three study screens (NOTES §65, the owner's decision). It was
  // everywhere but a growing list of exceptions — Nomi's own screen, the legal
  // pages, Community, the rooms, the groups, search, a post — each added
  // because it landed on a pinned Send or crowded a focused screen. The owner:
  // *"i'm starting to think that maybe we should remove the gemini chatbot at
  // the bottom right of the page"*; asked, he kept it where it earns its place:
  // a card in front of you, where it can see the card and answer "why is this
  // the answer?". Everywhere else, Nomi is its own tab.
  //
  // `path`, not `segments[2]`. `useSegments()` is typed from the route types
  // the dev server generates into `.expo/types/`, which is gitignored — so on
  // THIS machine it is a union deep enough to index, and on a clean checkout it
  // is `[string]`, where `segments[1]` is TS2493 and the build fails. That is a
  // typecheck error only CI can see, which is the worst kind: it passed here,
  // passed review, and broke the first run after the push (NOTES §47.8).
  const path = segments as readonly string[];
  const showAssistant = signedIn && path[0] === 'set' && ASSISTANT_SCREENS.includes(path[2] ?? '');

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
            tab that was Study, NOTES §40), Notes, Community, Progress and
            Profile (which took Settings' place, NOTES §51), as a
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
        {/* Settings left the tab bar for Profile (NOTES §51). Pushed like any
            other screen that is not a place, with its own heading in the body. */}
        <Stack.Screen name="settings" options={{ title: '', ...backable }} />
        {/* Somebody's page. Titled by its body — their name, which is long as
            often as not — and its ⋯ (Report, Block) set by the screen. */}
        <Stack.Screen name="person/[id]" options={{ title: '', ...backable }} />
        {/* Writing a post, and one post with its comments (NOTES §52). Tasks,
            not places: pushed with their own back control. */}
        {/* A sheet over whatever opened it — the feed, a set, Progress (NOTES
            §60, the owner's picture). On the web a transparent modal leaves the
            screen underneath drawn; the Sheet dims and blurs it. */}
        <Stack.Screen
          name="post/new"
          options={{ presentation: 'transparentModal', headerShown: false, animation: 'none', contentStyle: { backgroundColor: 'transparent' } }}
        />
        <Stack.Screen name="post/[id]" options={{ title: '', ...backable }} />
        {/* Search (NOTES §59): its own box and Cancel at the top, so no header. */}
        <Stack.Screen name="search" options={{ headerShown: false }} />
        {/* Your name, username and bio (§59), from Profile's Edit profile. */}
        <Stack.Screen name="edit-profile" options={{ title: '', ...backable }} />
        {/* A shared profile link, /u/<username> (§59): finds the person, opens their page. */}
        <Stack.Screen name="u/[username]" options={{ title: '', ...backable }} />
        {/* The Everyone room and a conversation with a friend (NOTES §53):
            pushed rooms, each titled by the screen. */}
        <Stack.Screen name="messages/everyone" options={{ title: 'Everyone', ...backable }} />
        <Stack.Screen name="messages/[id]" options={{ title: '', ...backable }} />
        {/* Groups (NOTES §58): making one, the room, and who is in it. */}
        <Stack.Screen name="groups/new" options={{ title: '', ...backable }} />
        <Stack.Screen name="groups/[id]/index" options={{ title: '', ...backable }} />
        <Stack.Screen name="groups/[id]/info" options={{ title: '', ...backable }} />
        {/* Each document names itself in its body. */}
        {/* The community rules, and the moderator's reports (NOTES §55). */}
        <Stack.Screen name="rules" options={{ title: '', ...backable }} />
        <Stack.Screen name="moderation" options={{ title: '', ...backable }} />
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
      {/* The rules, when a social act meets them first; and a moderator's
          warning, the next time the app opens (NOTES §55). Signed in only. */}
      {signedIn ? <RulesSheet /> : null}
      {signedIn ? <StandingNotice /> : null}
    </View>
  );
}

export default function RootLayout() {
  const scheme = useColorScheme();

  // What this person's screens showed last time goes back into the cache with
  // the first answer about who is signed in, before any screen asks for
  // anything, and the copy is kept up to date from then on (NOTES §71).
  useEffect(
    () =>
      startSessionListener({
        onFirstSession: (session) => void restoreSavedScreens(queryClient, session?.user.id ?? null),
      }),
    [],
  );
  useEffect(() => keepSavingScreens(queryClient, () => useSessionStore.getState().session?.user.id ?? null), []);
  // No browser menu over the app — a right click, an Android hold on a picture
  // (NOTES §72). The iPhone's hold menu is stopped by CSS in public/index.html.
  useEffect(() => keepBrowserMenusAway(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <RootNavigator />
    </QueryClientProvider>
  );
}
