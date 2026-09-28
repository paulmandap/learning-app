import { useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { CONTENT_MAX_WIDTH, space, TOUCH_TARGET, useTheme } from './theme';
import { Icon, type IconName } from './glyphs';
import { Sheet, SheetActions } from './sheet';

/**
 * Where the content column's left edge sits, in px from the window edge.
 *
 * `Screen` centres a CONTENT_MAX_WIDTH column inside space.lg of padding, so
 * the edge is `space.lg + (W - 2·space.lg - MAX)/2` — which simplifies exactly
 * to `(W - MAX)/2`, the padding cancelling out. The `max` covers narrow screens,
 * where the column is full-bleed and the edge is just the padding.
 *
 * Header controls are inset to this so the top of the screen lines up with the
 * content beneath it. At phone widths it resolves to space.lg, which is what the
 * header already used, so nothing moves on mobile.
 *
 * (This lives in the components rather than in the navigator's screenOptions
 * because native-stack has no headerLeftContainerStyle — that is a JS-stack
 * option and is silently absent here.)
 */
function useColumnEdge(): number {
  const { width } = useWindowDimensions();
  return Math.max(space.lg, (width - CONTENT_MAX_WIDTH) / 2);
}

/**
 * The header's own padding for its left and right slots, which has to be
 * subtracted. Measured from rendered screenshots rather than assumed: at 1440px
 * wide with a 560px column the content's left edge is 440, and a header LEFT
 * control given a 424px margin rendered at 424 — so those slots contribute none.
 */
const CONTROL_SLOT_PADDING = 0;

/**
 * A header overflow menu (⋯).
 *
 * This exists so that set-level actions — and Delete in particular — stop being
 * full-width buttons stacked in the scroll view directly under the navigation
 * controls, where a mis-tap reached a destructive action.
 *
 * It was a small panel pinned under the header's top-right corner. It is a
 * `Sheet` now, like every other temporary thing (NOTES §56.3): the page dims
 * and blurs, and the choices rise from the bottom, each with its icon, where a
 * thumb reaches them — the top right corner of a phone is the hardest place on
 * it to reach.
 */

export interface MenuItem {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** Renders in the danger colour. Does NOT remove the caller's confirm step. */
  destructive?: boolean;
}

export function OverflowMenu({ items, accessibilityLabel = 'More actions' }: {
  items: MenuItem[];
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const gutter = useColumnEdge() - CONTROL_SLOT_PADDING;
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={() => setOpen(true)}
        hitSlop={12}
        style={{
          width: TOUCH_TARGET,
          height: TOUCH_TARGET,
          alignItems: 'flex-end',
          justifyContent: 'center',
          marginRight: gutter,
        }}
      >
        <Icon name="more" color={t.text} />
      </Pressable>

      {open ? (
        <Sheet onClose={() => setOpen(false)}>
          <SheetActions
            actions={items.map((item) => ({
              ...item,
              onPress: () => {
                // Close FIRST: leaving the menu open while a confirm or a
                // navigation happens underneath it strands the user behind a
                // backdrop they then have to dismiss.
                setOpen(false);
                item.onPress();
              },
            }))}
          />
        </Sheet>
      ) : null}
    </>
  );
}

/**
 * An explicit header back control.
 *
 * The stack's own back chevron only appears when the navigator has somewhere to
 * go back TO, and in this app there are two ordinary ways to end up without
 * that: creating a set lands via `router.replace` (so "back" cannot return you
 * to the half-filled form), and reloading or reopening the installed PWA on a
 * deep URL rebuilds the stack with a single screen.
 *
 * An installed iOS PWA has no edge-swipe-back either, so when the chevron is
 * missing there is genuinely no way out of the screen. This falls back to Home
 * rather than rendering nothing, which is the difference between a tidy header
 * and a dead end.
 */
export function HeaderBackButton({
  label = 'Back',
  onBeforeLeave,
}: {
  label?: string;
  /**
   * Awaited before navigating. Nomi's screen uses it to wave goodbye; the
   * caller is responsible for keeping it short and for it always settling,
   * because a back button that waits on something that never finishes is a
   * dead end with extra steps.
   */
  onBeforeLeave?: () => Promise<void>;
}) {
  const t = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const gutter = useColumnEdge() - CONTROL_SLOT_PADDING;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={async () => {
        if (onBeforeLeave) await onBeforeLeave();
        if (navigation.canGoBack()) router.back();
        else router.replace('/');
      }}
      hitSlop={12}
      // Icon only, and a full 44px target. The word "Back" alongside the
      // chevron competed with the screen title for the same line, which is
      // exactly what pushed long titles into collision. With the title moved
      // below the bar, the chevron carries the meaning on its own.
      style={{
        width: TOUCH_TARGET,
        height: TOUCH_TARGET,
        alignItems: 'flex-start',
        justifyContent: 'center',
        marginLeft: gutter,
      }}
    >
      {/* The text colour, as the owner's picture has it: the header's
          controls are quiet, and the accent is kept for what is chosen. */}
      <Icon name="back" color={t.text} size={26} />
    </Pressable>
  );
}

/**
 * One icon button at the right of a header, inset to the content column like
 * the ⋯ — a post's ⋯ on its own page, whose sheet belongs to the post list.
 */
export function HeaderIconButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const t = useTheme();
  const gutter = useColumnEdge() - CONTROL_SLOT_PADDING;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={12}
      style={{
        width: TOUCH_TARGET,
        height: TOUCH_TARGET,
        alignItems: 'flex-end',
        justifyContent: 'center',
        marginRight: gutter,
      }}
    >
      <Icon name={icon} color={t.text} />
    </Pressable>
  );
}

/**
 * Several icon buttons at the right of a header — Nomi's "your chats" and
 * "new chat". One gutter for the row, not one per button, so the last button
 * lines up with the content column like every other header control.
 */
export function HeaderActions({
  actions,
}: {
  actions: { icon: IconName; label: string; onPress: () => void }[];
}) {
  const t = useTheme();
  const gutter = useColumnEdge() - CONTROL_SLOT_PADDING;
  return (
    <View style={{ flexDirection: 'row', marginRight: gutter }}>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          hitSlop={6}
          style={{ width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name={action.icon} color={t.text} />
        </Pressable>
      ))}
    </View>
  );
}
