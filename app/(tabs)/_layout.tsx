import { forwardRef } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { TabList, TabSlot, TabTrigger, Tabs, type TabTriggerSlotProps } from 'expo-router/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, space, useTheme } from '../../src/ui/theme';

/**
 * Global navigation (spec §2).
 *
 * The spec has always asked for this — *"Desktop uses a centered ≤720px content
 * column, sidebar nav; mobile uses bottom tabs"* — and it was never built. Until
 * now the only route anywhere was Home, with Settings reachable through a single
 * gear in the header.
 *
 * ## Built from the headless primitive, not a tab library
 *
 * `expo-router/ui` provides `Tabs`/`TabList`/`TabTrigger` with no styling and no
 * extra dependency; `@react-navigation/bottom-tabs` is not installed and adding
 * it would buy a default appearance this project would then have to override.
 * The rule is not to add dependencies without a measured reason, and the whole
 * bar below is about seventy lines.
 *
 * It also happens to be the only straightforward way to get the spec's two
 * layouts — bar at the bottom on a phone, rail down the side on a desktop — out
 * of one component, since that is a flex-direction change here rather than a
 * navigator that has to support it.
 *
 * ## The study screens deliberately sit ABOVE this
 *
 * `set/[id]/*` stays in the root stack, so opening a deck covers the bar. A
 * flashcard session is a focused task with its own back control, and a nav bar
 * offering two ways out mid-session is a distraction, not an option. Everything
 * that is a *place* is a tab; everything that is a *task* is pushed.
 */

/** Below this the bar sits at the bottom; at or above it, down the left. */
const SIDEBAR_MIN_WIDTH = 800;

const TABS = [
  { name: 'index', href: '/', label: 'Study', glyph: '✎' },
  { name: 'progress', href: '/progress', label: 'Progress', glyph: '◕' },
  { name: 'settings', href: '/settings', label: 'Settings', glyph: '⚙︎' },
] as const;

/**
 * One tab button.
 *
 * `TabTrigger asChild` hands us `isFocused` and the press handling, so this is
 * only appearance. A ref is required because the trigger forwards one.
 *
 * Label AND glyph, always. The glyphs are decorative — a pencil, a part-filled
 * circle and a gear are not self-evident, and an icon-only bar would be a
 * guessing game. The words are what makes it navigable.
 */
const TabButton = forwardRef<View, TabTriggerSlotProps & { label: string; glyph: string }>(
  ({ label, glyph, isFocused, children, ...props }, ref) => {
    const t = useTheme();
    const { width } = useWindowDimensions();
    const sidebar = width >= SIDEBAR_MIN_WIDTH;
    const tint = isFocused ? t.accent : t.textMuted;

    return (
      <Pressable
        ref={ref}
        {...props}
        accessibilityRole="tab"
        accessibilityState={{ selected: !!isFocused }}
        style={{
          flex: sidebar ? undefined : 1,
          flexDirection: sidebar ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: sidebar ? 'flex-start' : 'center',
          gap: sidebar ? space.sm : 2,
          paddingVertical: space.sm,
          paddingHorizontal: sidebar ? space.md : 0,
          borderRadius: radius.sm,
          // A selected tab in the sidebar gets a filled pill; at the bottom
          // there is not enough height for one, so colour carries it there.
          backgroundColor: sidebar && isFocused ? t.bg : 'transparent',
          // 44pt minimum touch target, as everywhere else in this app.
          minHeight: 44,
        }}
      >
        <Text style={{ fontSize: sidebar ? 15 : 17, color: tint }}>{glyph}</Text>
        <Text
          style={{
            fontSize: sidebar ? 15 : 11,
            // Weight as well as colour: the selected tab must be identifiable
            // without relying on hue, the same rule the quiz options follow.
            fontWeight: isFocused ? '700' : '500',
            color: tint,
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  },
);
TabButton.displayName = 'TabButton';

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const sidebar = width >= SIDEBAR_MIN_WIDTH;

  return (
    <Tabs
      // Row on a desktop puts the rail on the left; column-reverse on a phone
      // puts the bar under the content. One tree, two layouts.
      style={{ flex: 1, flexDirection: sidebar ? 'row' : 'column-reverse' }}
      options={{ backBehavior: 'history' }}
    >
      {/* TabList must be a DIRECT child of Tabs, and the triggers direct
          children of it. Tabs discovers which routes exist by walking its own
          children for a TabList and reading the TabTriggers inside — so a
          custom <Bar> wrapper around them hides the lot. That is not a
          hypothetical: wrapping them threw "Couldn't find any screens for the
          navigator" and shipped a blank page, which tests/boot.test.ts caught.

          TabList takes ViewProps, so it can be styled in place and no wrapper
          is needed for appearance either. */}
      <TabList
        style={
          sidebar
            ? {
                flexDirection: 'column',
                // Explicit, because TabList brings its own justification and
                // without this the three tabs spread themselves down the whole
                // height — Study at the top, Settings pinned to the bottom of
                // the window. Caught by screenshotting it; nothing else would
                // have.
                justifyContent: 'flex-start',
                alignItems: 'stretch',
                gap: space.xs,
                width: 200,
                paddingTop: insets.top + space.lg,
                paddingHorizontal: space.sm,
                borderRightWidth: 1,
                borderRightColor: t.border,
                backgroundColor: t.card,
              }
            : {
                flexDirection: 'row',
                // The home indicator on a modern iPhone sits below the bar, so
                // this has to come from the inset rather than a guess.
                paddingBottom: insets.bottom,
                paddingTop: space.xs,
                borderTopWidth: 1,
                borderTopColor: t.border,
                backgroundColor: t.card,
              }
        }
      >
        {TABS.map((tab) => (
          <TabTrigger key={tab.name} name={tab.name} href={tab.href} asChild>
            <TabButton label={tab.label} glyph={tab.glyph} />
          </TabTrigger>
        ))}
      </TabList>
      <TabSlot />
    </Tabs>
  );
}
