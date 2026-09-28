import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Rows } from './components';
import { Icon, type IconName } from './glyphs';
import { useReducedMotion } from './motion';
import { CONTENT_MAX_WIDTH, elevation, radius, space, type, useTheme } from './theme';

/**
 * Everything temporary, in one kind of panel (NOTES §56.3).
 *
 * The owner, on the social screens as they were: *"make it at least the user
 * will only focus there, like there is a background blur when clicked."* So
 * every menu, every choice about a post or a message, report, block and the
 * rules is this: the page behind dimmed and blurred, and a panel risen from the
 * bottom with a grab handle and rounded top corners — one thing at a time.
 *
 * ## The backdrop is BESIDE the panel, not around it
 *
 * It used to be a button that contained the whole panel, so a screen reader met
 * one "Close" button with every control of the sheet inside it — buttons within
 * a button. Now it is a sibling filling the window behind the panel: tapping
 * outside still closes, and the panel's controls are its own.
 *
 * ## Width
 *
 * A phone gets the whole width. A desktop gets the content column, centred — a
 * panel spanning 1440 px with six emoji at its left end read as broken.
 */
export function Sheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  // 1 is lowered, 0 is in place. The Modal fades the dimmed page in; the panel
  // also rises a little, which is what says "this came up from the bottom".
  const lowered = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduce) {
      lowered.setValue(0);
      return;
    }
    Animated.timing(lowered, {
      toValue: 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [reduce, lowered]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', zIndex: elevation.float + 1 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={[
            { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0, 0, 0, 0.55)' },
            // Safari still wants the prefix on some versions; the owner's
            // iPhone is Safari.
            Platform.OS === 'web'
              ? ({ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' } as object)
              : null,
          ]}
        />
        <Animated.View
          style={{
            width: '100%',
            maxWidth: CONTENT_MAX_WIDTH + 2 * space.lg,
            alignSelf: 'center',
            maxHeight: '90%',
            backgroundColor: t.bg,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderTopWidth: 1,
            borderColor: t.border,
            paddingBottom: insets.bottom,
            transform: [{ translateY: lowered.interpolate({ inputRange: [0, 1], outputRange: [0, 48] }) }],
          }}
        >
          {/* The grab handle: says "this is a panel over the page", where every
              phone puts one. Drawn, not dragged — tapping outside closes it. */}
          <View
            style={{
              alignSelf: 'center',
              width: 36,
              height: 5,
              borderRadius: 3,
              marginTop: space.sm,
              backgroundColor: t.border,
            }}
          />
          <ScrollView
            contentContainerStyle={{ padding: space.lg, paddingTop: space.md, gap: space.md }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

/**
 * A sheet's heading. A title, not a `Label`: photographed at 393px, "Report
 * Probe B" in small grey type read as a caption over the list rather than as
 * what the whole sheet was for.
 */
export function SheetTitle({ children }: { children: string }) {
  const t = useTheme();
  return (
    <Text style={[type.title, { color: t.text }]} accessibilityRole="header">
      {children}
    </Text>
  );
}

export interface SheetAction {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** Report, block, delete: the danger colour. Never instead of a confirm step. */
  destructive?: boolean;
  disabled?: boolean;
  /** A line under the label, for what the action does when that is not obvious. */
  detail?: string;
}

/**
 * A sheet's choices: one grouped list, an icon on each row (the conversation
 * sheet in the owner's picture). Rows that do not apply are passed as `null`
 * and left out.
 */
export function SheetActions({ actions }: { actions: (SheetAction | null | false)[] }) {
  return (
    <Rows card>
      {actions.filter((a): a is SheetAction => !!a).map((a) => (
        <ActionRow key={a.label} {...a} />
      ))}
    </Rows>
  );
}

function ActionRow({ icon, label, onPress, destructive, disabled, detail }: SheetAction) {
  const t = useTheme();
  const color = destructive ? t.danger : t.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md + space.hair,
        minHeight: 52,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        backgroundColor: pressed ? t.bg : 'transparent',
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Icon name={icon} color={color} size={22} />
      <View style={{ flex: 1, gap: space.hair }}>
        <Text style={[type.body, { color }]}>{label}</Text>
        {detail ? <Text style={[type.caption, { color: t.textMuted }]}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}
