import { useRouter } from 'expo-router';
import { Body, Button, Card, Screen, Title } from '../src/ui/components';

/**
 * The screen for a URL this app does not have.
 *
 * Without this file Expo Router falls back to its own unstyled default, which
 * is a developer's screen: it names the route pattern it could not match and
 * offers nothing to do about it. That is reachable in normal use here, not only
 * by mistyping — `router.replace` after creating a set and after deleting one
 * both rewrite the URL, and an installed PWA reopened on a deep link rebuilds
 * the stack from that URL alone. A set the student has since deleted, a link
 * shared from an older build, or a reload during a redirect all land here.
 *
 * So it is written the way the rest of the app is written: no route pattern, no
 * status code, one plain sentence and one way out. Everything is built from the
 * existing kit, so light and dark come from `useTheme` inside those components
 * rather than from anything new here.
 *
 * `replace` rather than `push`: a not-found page is nothing to keep in history,
 * and the usual reason for being here is a stack with no history to return to.
 * The header chevron handles the other case on its own — `HeaderBackButton`
 * already falls back to Home when the navigator cannot go back.
 */
export default function NotFound() {
  const router = useRouter();

  return (
    <Screen centered>
      <Title>We couldn't find that page</Title>
      <Card>
        <Body>
          The link may be out of date, or the set or note it points to may have been deleted.
        </Body>
        <Button label="Go to your sets" onPress={() => router.replace('/')} />
      </Card>
    </Screen>
  );
}
