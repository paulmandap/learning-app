import { useState, type ReactNode } from 'react';
import { Modal, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { CONTENT_MAX_WIDTH, radius, space, TOUCH_TARGET, type, useTheme } from './theme';

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
 * The header's own padding, which differs by slot and has to be subtracted.
 *
 * Measured from rendered screenshots rather than assumed: at 1440px wide with a
 * 560px column the content's left edge is 440, and a header TITLE given a
 * 424px margin rendered at 440 while a header LEFT control given the same 424
 * rendered at 424. So the title slot contributes space.lg of padding and the
 * left and right slots contribute none.
 */
const TITLE_SLOT_PADDING = space.lg;
const CONTROL_SLOT_PADDING = 0;

/**
 * A header overflow menu (⋯).
 *
 * React Native has no menu primitive and no popover, so this is a `Modal` with a
 * full-screen transparent backdrop and a panel pinned under the header's
 * top-right corner. A Modal rather than an absolutely-positioned View because
 * only a Modal reliably paints above the navigation header on both web and
 * native, and it captures the outside tap that dismisses the menu.
 *
 * This exists so that set-level actions — and Delete in particular — stop being
 * full-width buttons stacked in the scroll view directly under the navigation
 * controls, where a mis-tap reached a destructive action.
 */

export interface MenuItem {
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
        {/* U+22EF. Renders as text everywhere, unlike an emoji ellipsis. */}
        <Text style={{ color: t.accent, fontSize: 24, lineHeight: 28 }}>⋯</Text>
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        {/* The backdrop is the dismiss target, so the menu closes the way every
            other menu on the platform does. */}
        <Pressable
          onPress={() => setOpen(false)}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }}
        >
          <View
            style={{
              position: 'absolute',
              top: 56,
              right: space.md,
              minWidth: 200,
              backgroundColor: t.card,
              borderColor: t.border,
              borderWidth: 1,
              borderRadius: radius.md,
              overflow: 'hidden',
              // Enough lift to read as floating above the page on both themes.
              shadowColor: '#000',
              shadowOpacity: 0.3,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: 8 },
              elevation: 8,
            }}
          >
            {items.map((item, i) => (
              <Pressable
                key={item.label}
                accessibilityRole="button"
                onPress={() => {
                  // Close FIRST: leaving the menu open while a confirm or a
                  // navigation happens underneath it strands the user behind a
                  // backdrop they then have to dismiss.
                  setOpen(false);
                  item.onPress();
                }}
                style={({ pressed }) => ({
                  paddingHorizontal: space.lg,
                  paddingVertical: space.md,
                  minHeight: TOUCH_TARGET,
                  justifyContent: 'center',
                  backgroundColor: pressed ? t.bg : 'transparent',
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: t.border,
                })}
              >
                <Text
                  style={[type.body, { color: item.destructive ? t.danger : t.text }]}
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
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
export function HeaderBackButton({ label = 'Back' }: { label?: string }) {
  const t = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const gutter = useColumnEdge() - CONTROL_SLOT_PADDING;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
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
      {/* U+2039, sized to read as a chevron rather than a stray character. */}
      <Text style={{ color: t.accent, fontSize: 32, lineHeight: 36, marginTop: -4 }}>‹</Text>
    </Pressable>
  );
}

/**
 * A header title inset to the content column.
 *
 * Only needed on screens with NO back control. Where a chevron is present the
 * title is laid out after it, and since the chevron is already inset the title
 * follows automatically.
 *
 * Without this the header was aligned on one side only — the gear pulled in to
 * the column's right edge while "Study" stayed hard against the window's left —
 * which looked worse than leaving both at the window edges.
 */
export function HeaderTitle({ children }: { children: string }) {
  const t = useTheme();
  const gutter = Math.max(0, useColumnEdge() - TITLE_SLOT_PADDING);
  return (
    <Text style={[type.title, { color: t.text, marginLeft: gutter }]} numberOfLines={1}>
      {children}
    </Text>
  );
}

/** A header button that is just a glyph — the Settings gear on Home. */
export function HeaderGlyphButton({
  glyph,
  onPress,
  accessibilityLabel,
}: {
  glyph: ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const t = useTheme();
  const gutter = useColumnEdge() - CONTROL_SLOT_PADDING;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={12}
      // A full 44px target, centred: the gear was both small to hit and sitting
      // visually high against the title's cap height.
      style={{
        width: TOUCH_TARGET,
        height: TOUCH_TARGET,
        alignItems: 'flex-end',
        justifyContent: 'center',
        marginRight: gutter,
      }}
    >
      <Text style={{ color: t.accent, fontSize: 24, lineHeight: 28 }}>{glyph}</Text>
    </Pressable>
  );
}
