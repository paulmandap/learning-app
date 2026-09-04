import { useState, type ReactNode } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { radius, space, TOUCH_TARGET, type, useTheme } from './theme';

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
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={() => setOpen(true)}
        hitSlop={12}
        style={{ paddingHorizontal: space.sm, paddingVertical: space.xs }}
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={12}
      style={{ paddingHorizontal: space.sm, paddingVertical: space.xs }}
    >
      <Text style={{ color: t.accent, fontSize: 20, lineHeight: 24 }}>{glyph}</Text>
    </Pressable>
  );
}
