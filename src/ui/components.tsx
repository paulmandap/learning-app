import { useEffect, useRef, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  CONTENT_MAX_WIDTH,
  FLOAT_CLEARANCE,
  INPUT_FONT_SIZE,
  radius,
  space,
  TOUCH_TARGET,
  type,
  useTheme,
} from './theme';

/** Centred ≤720px column on desktop, full width on mobile. */
export function Screen({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={styles.screenContent}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: space.lg }}>{children}</View>
    </ScrollView>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>{children}</View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.title, { color: t.text }]}>{children}</Text>;
}

/**
 * A screen heading with an optional control on the right.
 *
 * ## Why this is a primitive and not four hand-written rows
 *
 * A tab root has no navigator header to hang anything on — `headerShown` is
 * false for the whole (tabs) group — so each one names itself with a `Title` as
 * the first child of `Screen`. Anything that belongs "in the header area" of a
 * tab therefore has to live in the body beside that title.
 *
 * Progress alone renders its title from three separate early returns (loading,
 * nothing-answered-yet, and the real screen) and Study from one. Writing the
 * row out four times is how three of them quietly drift apart.
 *
 * ## No gutter here, deliberately
 *
 * `menu.tsx` has `HeaderTitle` and `HeaderGlyphButton`, which look like exactly
 * this and are not: they carry a `marginLeft`/`marginRight` that compensates for
 * a stack header spanning the whole window. Inside `Screen` the column is
 * already centred at CONTENT_MAX_WIDTH, so reusing them would inset the row a
 * second time and push the control off the column's edge.
 */
export function TitleRow({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.titleRow}>
      <Title>{title}</Title>
      {action ?? null}
    </View>
  );
}

/**
 * A large in-body screen heading, iOS "large title" style.
 *
 * Used where the name is long enough to fight the navigation bar — a set called
 * "Animal biology study reviewer" collided with the back control and the ⋯ when
 * it sat in the header. Down here it wraps freely and the top bar stays to the
 * two things it is for.
 */
export function Display({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[type.display, { color: t.text }]}>{children}</Text>;
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const t = useTheme();
  return <Text style={[styles.body, { color: muted ? t.textMuted : t.text }]}>{children}</Text>;
}

/**
 * Three rungs, deliberately:
 *
 *  - `primary`   solid accent. ONE per screen — it is the thing you came to do.
 *  - `outline`   accent border and text. A real alternative that is not the
 *                default: Quiz alongside Flashcards.
 *  - `secondary` neutral grey outline. Tertiary and administrative actions.
 *
 * Before `outline` existed, Flashcards and Quiz were both `primary` and competed
 * for the same attention, which is what flattened the set screen.
 */
export function Button({
  label,
  onPress,
  busy,
  disabled,
  variant = 'primary',
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'outline' | 'secondary';
}) {
  const t = useTheme();
  const off = disabled || busy;

  const fill = variant === 'primary' ? t.accent : 'transparent';
  const border = variant === 'primary' ? t.accent : variant === 'outline' ? t.accent : t.border;
  const label_ = variant === 'primary' ? t.accentText : variant === 'outline' ? t.accent : t.text;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={off}
      style={[
        styles.button,
        {
          backgroundColor: fill,
          borderColor: border,
          // An outline button earns a heavier edge; at 1px against the page it
          // reads as disabled text rather than as a control.
          borderWidth: variant === 'outline' ? 2 : 1,
          opacity: off ? 0.55 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={label_} />
      ) : (
        <Text style={[styles.buttonLabel, { color: label_ }]}>{label}</Text>
      )}
    </Pressable>
  );
}

/**
 * A tappable row in a list.
 *
 * Replaces the stack of full-height `Card`s the set list used to be. Those gave
 * every set the visual weight of a primary surface, so ten sets read as ten
 * competing panels; a row with a chevron reads as one item among many, which is
 * what a list of sets actually is.
 */
export function ListRow({
  title,
  meta,
  onPress,
}: {
  title: string;
  meta?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: t.card,
          borderColor: t.border,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={2}>
          {title}
        </Text>
        {meta ? <Text style={[type.caption, { color: t.textMuted }]}>{meta}</Text> : null}
      </View>
      {/* U+203A. A glyph rather than an icon set: @expo/vector-icons is not
          installed and three chevrons is not a reason to add it. */}
      <Text style={{ color: t.textMuted, fontSize: 22, marginLeft: space.md }}>›</Text>
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  keyboardType,
  autoCapitalize = 'none',
  maxLength,
  onSubmitEditing,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboardType?: 'default' | 'email-address' | 'number-pad';
  autoCapitalize?: 'none' | 'sentences';
  maxLength?: number;
  /**
   * Enter submits. Typing an answer and pressing return is the whole
   * interaction on a desktop keyboard; reaching for the mouse to confirm a
   * one-word answer is what makes a typing drill feel slow.
   */
  onSubmitEditing?: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.label, { color: t.textMuted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.textMuted}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        maxLength={maxLength}
        onSubmitEditing={onSubmitEditing}
        returnKeyType={onSubmitEditing ? 'done' : undefined}
        style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]}
      />
    </View>
  );
}

/**
 * Progress through a study session.
 *
 * A bar rather than only "7 of 20": seeing the remainder shrink is what makes a
 * deck feel finishable, and it is the one persistent piece of feedback during a
 * session on a device that cannot buzz.
 */
export function ProgressBar({ value, total }: { value: number; total: number }) {
  const t = useTheme();
  const pct = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  const width = useRef(new Animated.Value(pct)).current;

  useEffect(() => {
    Animated.timing(width, {
      toValue: pct,
      duration: 260,
      useNativeDriver: false, // width cannot be driven natively
    }).start();
  }, [pct, width]);

  return (
    <View style={{ gap: space.xs }}>
      <View
        style={{
          height: 6,
          borderRadius: radius.pill,
          backgroundColor: t.border,
          overflow: 'hidden',
        }}
      >
        <Animated.View
          style={{
            height: '100%',
            borderRadius: radius.pill,
            backgroundColor: t.accent,
            width: width.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
          }}
        />
      </View>
      <Text style={[type.caption, { color: t.textMuted }]}>
        {value} of {total}
      </Text>
    </View>
  );
}

/** Inline status line. Never renders a raw API message or a key. */
/**
 * Inline status line. Never renders a raw API message or a key.
 *
 * `info` exists because the Settings privacy note is INFORMATION and was
 * wearing alarm amber for want of anywhere else to sit — three paragraphs of
 * warning colour as the first thing on the screen (NOTES §35).
 */
export function Notice({
  tone,
  children,
}: {
  tone: 'ok' | 'error' | 'warn' | 'info';
  children: ReactNode;
}) {
  const t = useTheme();
  const color =
    tone === 'ok' ? t.ok : tone === 'error' ? t.danger : tone === 'info' ? t.infoText : t.warnText;
  const bg = tone === 'warn' ? t.warnBg : tone === 'info' ? t.infoBg : 'transparent';
  return (
    <View style={[styles.notice, { backgroundColor: bg }]}>
      <Text style={[styles.body, { color }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screenContent: {
    alignItems: 'center',
    padding: space.lg,
    // A 28px large title sitting 16px under the navigation bar reads as text
    // that happens to be first rather than as a heading. It needs room above it.
    paddingTop: space.xxl,
    // Clears the floating ✦ rather than guessing. This was 48 — less than the
    // button's own height — so on Settings the ✦ covered "Test connection".
    // One token, so a screen cannot forget and the number cannot drift from
    // the thing it is avoiding (NOTES §35).
    paddingBottom: FLOAT_CLEARANCE,
  },
  card: { borderWidth: 1, borderRadius: radius.md, padding: space.lg, gap: space.md },
  row: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: TOUCH_TARGET,
  },
  title: type.title,
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    // The control is a full 44px target, so the row takes its height from that
    // rather than from the 28px title — otherwise the heading would shift down
    // only on the screens that carry one.
    minHeight: TOUCH_TARGET,
  },
  body: type.body,
  label: type.label,
  input: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: INPUT_FONT_SIZE,
    minHeight: TOUCH_TARGET,
  },
  button: {
    borderWidth: 1,
    borderRadius: radius.button,
    // Deliberately NOT capped. A 400px cap was tried and reverted: buttons then
    // sat at 400 while the Cards and ListRows stacked directly above and below
    // them stayed at the full column width, and two different widths in one
    // column reads as broken far more loudly than a wide button does. If button
    // width is ever revisited, the column width is the thing to change — every
    // element in it has to agree.
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
  },
  buttonLabel: type.button,
  notice: { borderRadius: radius.sm, paddingVertical: space.sm, paddingHorizontal: space.md },
});

/**
 * A small count or status label.
 *
 * Exists because counts were being concatenated into button labels — the level
 * pickers rendered `"Remember 5"` as one string, so "Remember 5" wrapped to two
 * lines while "Apply 4" did not (NOTES §35). A count is a different kind of
 * thing from a label and should be able to sit beside one.
 */
export function Chip({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent';
}) {
  const t = useTheme();
  const onAccent = tone === 'accent';
  return (
    <View
      style={{
        borderRadius: radius.pill,
        paddingHorizontal: space.sm,
        paddingVertical: space.hair,
        backgroundColor: onAccent ? t.accent : t.bg,
        borderWidth: 1,
        borderColor: onAccent ? t.accent : t.border,
      }}
    >
      <Text style={[type.caption, { color: onAccent ? t.accentText : t.textMuted }]}>
        {children}
      </Text>
    </View>
  );
}

/**
 * Nothing here yet, said once.
 *
 * The audit found seven near-duplicate empty strings across the study screens,
 * including three different phrasings of the SAME sentence about the retry
 * pile. That is §23.2's "three copies drift apart", in copy rather than code —
 * so the wording lives in one place and the screens pass a subject.
 */
export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: space.xs, paddingVertical: space.lg }}>
      <Text style={[type.bodyStrong, { color: t.text }]}>{title}</Text>
      {detail ? <Text style={[type.body, { color: t.textMuted }]}>{detail}</Text> : null}
    </View>
  );
}

/**
 * Waiting, said the same way everywhere.
 *
 * `Loading…` appeared eight times as bare muted text, hand-written per screen.
 * No spinner by default: a study app that flashes a spinner for a 60ms cached
 * read is noisier than one that simply says what it is doing.
 */
export function LoadingState({ what = 'Loading…' }: { what?: string }) {
  const t = useTheme();
  return (
    <View style={{ paddingVertical: space.lg }}>
      <Text style={[type.body, { color: t.textMuted }]}>{what}</Text>
    </View>
  );
}
