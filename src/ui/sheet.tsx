import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Modal, Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Rows } from './components';
import { Icon, type IconName } from './glyphs';
import { useReducedMotion } from './motion';
import { CONTENT_MAX_WIDTH, elevation, radius, space, type, useTheme } from './theme';
import { placePopover, type Anchor } from '../core/popover';

/**
 * Everything temporary, in one kind of panel (NOTES §56.3).
 *
 * The owner, on the social screens as they were: *"make it at least the user
 * will only focus there, like there is a background blur when clicked."* So
 * every menu, every choice about a post or a message, report, block and the
 * rules is this: the page behind dimmed and blurred, and a panel over it — one
 * thing at a time.
 *
 * ## In the middle of the screen (NOTES §65)
 *
 * It rose from the bottom with a grab handle. The owner, with What's new at
 * the bottom of a laptop screen: *"i don't want it sitting at the bottom
 * middle. middle middle is better."* — and asked, on the phone too. So it is a
 * card in the middle, every corner round, the safe areas and a margin kept
 * clear all round. No grab handle: nothing here is dragged, and a handle on a
 * card in the middle points at nothing.
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
 * A phone gets the whole width less a margin. A desktop gets the content
 * column — a panel spanning 1440 px with six emoji at its left end read as
 * broken.
 *
 * ## Header and footer stay put (NOTES §60)
 *
 * What scrolls is the middle. `header` sits at the top and `footer` at the
 * bottom, outside the scroll — the new post's Cancel · New post · Post and its
 * toolbar, as in the owner's picture, and the one button a long sheet ends in
 * ("I agree", "Send report"), which seven rules had pushed below the fold on a
 * phone. `tall` gives the sheet most of the screen whatever is in it, for
 * writing in.
 */
/** A tall sheet's height at most: past this, on a big screen, it is a wall rather than a card. */
const TALL_MAX = 760;
export function Sheet({
  children,
  onClose,
  header,
  footer,
  tall,
}: {
  children: ReactNode;
  onClose: () => void;
  header?: ReactNode;
  footer?: ReactNode;
  tall?: boolean;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const reduce = useReducedMotion();
  // 1 is lowered, 0 is in place. The Modal fades the dimmed page in; the panel
  // also rises a little into place, which is what says "this came up".
  const lowered = useRef(new Animated.Value(1)).current;
  const room = windowHeight - insets.top - insets.bottom - 2 * space.lg;

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
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          paddingTop: insets.top + space.lg,
          paddingBottom: insets.bottom + space.lg,
          paddingHorizontal: space.lg,
          zIndex: elevation.float + 1,
        }}
      >
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
            maxHeight: '100%',
            height: tall ? Math.min(room, TALL_MAX) : undefined,
            backgroundColor: t.bg,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: t.border,
            overflow: 'hidden',
            shadowColor: '#000',
            shadowOpacity: 0.3,
            shadowRadius: 24,
            shadowOffset: { width: 0, height: 8 },
            elevation: 12,
            transform: [{ translateY: lowered.interpolate({ inputRange: [0, 1], outputRange: [0, 16] }) }],
          }}
        >
          {header ? <View style={{ paddingHorizontal: space.lg, paddingTop: space.md }}>{header}</View> : null}
          <ScrollView
            // Without a header or footer the scroll is as tall as what is in
            // it; with one, it takes what they leave.
            style={header || footer || tall ? { flexShrink: 1, flexGrow: tall ? 1 : 0 } : undefined}
            contentContainerStyle={{ padding: space.lg, paddingTop: header ? space.md : space.lg, gap: space.md }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? (
            <View
              style={{
                paddingHorizontal: space.lg,
                paddingTop: space.sm,
                paddingBottom: space.md,
                gap: space.sm,
                borderTopWidth: 1,
                borderTopColor: t.border,
              }}
            >
              {footer}
            </View>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

/**
 * A small panel beside what opened it — Messenger's reaction bar over a
 * message (NOTES §65). The owner: the emoji and the ⋯ beside a message
 * *"serve the same purpose. when i click on emoji, it should look like that
 * too just like messenger"* — a bar of reactions over the bubble, not a sheet.
 *
 * The page is not dimmed: this is a quick pick next to the thing, and the
 * thing should stay in view. A tap anywhere else closes it, as does Escape.
 * `anchor` is where the opener is on screen (`measureInWindow`); it opens
 * above it when `height` fits there, or where there is more room.
 */
export function Popover({
  anchor,
  width,
  height,
  side,
  label,
  onClose,
  children,
}: {
  anchor: Anchor;
  width: number;
  /** How tall it may grow. */
  height: number;
  /** Lined up with the anchor's left edge, or its right. */
  side: 'start' | 'end';
  /** What it is, for a screen reader. */
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const at = placePopover(anchor, { width, height }, side, window, {
    top: insets.top + space.sm,
    bottom: insets.bottom + space.sm,
    side: space.sm,
  });

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, zIndex: elevation.float + 1 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        />
        <View
          accessibilityLabel={label}
          style={{
            position: 'absolute',
            left: at.left,
            top: at.top,
            bottom: at.bottom,
            width: at.width,
            maxHeight: at.maxHeight,
            padding: space.xs,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.card,
            shadowColor: '#000',
            shadowOpacity: 0.3,
            shadowRadius: 16,
            shadowOffset: { width: 0, height: 4 },
            elevation: 10,
          }}
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}

/**
 * The whole screen, black, for one thing to look at — a post's photo
 * (NOTES §65). Not a panel over the page, so none of the Sheet's dimming or
 * margins: what is behind is gone until it closes. Escape and the phone's
 * back close it.
 */
export function FullScreen({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000000', zIndex: elevation.float + 1 }}>{children}</View>
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
