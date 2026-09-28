import { Children, Fragment, useEffect, useRef, type ReactNode } from 'react';
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
import { Icon, type IconName } from './glyphs';

/**
 * Centred CONTENT_MAX_WIDTH column on desktop, full width on mobile.
 *
 * ## `centered`, for screens that are one short thing
 *
 * Sign-in and not-found are each a single card. Anchored to the top of a phone
 * they left most of the screen empty beneath them, and a lone card over a dark
 * void reads as a page that has not finished loading — on sign-in, the first
 * screen anyone sees (NOTES §35). Centred, the same card is plainly the whole
 * page.
 *
 * Deliberately NOT for content screens. A list starts at the top because that
 * is where the eye looks for its first item, and the space under a short list
 * is not a defect — it fills as sets and notes are added. It is also not for
 * anything inside the tabs, whose scroll area `TabSlot` bounds (NOTES §33).
 *
 * `flexGrow` rather than `flex`, so content taller than the window still
 * scrolls exactly as before.
 */
export function Screen({ children, centered }: { children: ReactNode; centered?: boolean }) {
  const t = useTheme();
  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={[styles.screenContent, centered ? styles.screenCentered : null]}
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
 * The stack header's controls in `menu.tsx` carry a `marginLeft`/`marginRight`
 * that compensates for a header spanning the whole window. Inside `Screen` the
 * column is already centred at CONTENT_MAX_WIDTH, so the same inset here would
 * push the control off the column's edge.
 */
export function TitleRow({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.titleRow}>
      <Title>{title}</Title>
      {action ?? null}
    </View>
  );
}

export interface TopBarAction {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** A count on the icon's corner — unread messages. */
  badge?: string | null;
}

/**
 * The top of a tab: a large title on the left, its actions as icons on the
 * right (NOTES §56.3, the owner's picture).
 *
 * The redesign's rule: the top bar carries the screen's actions — search,
 * messages, settings, a new message — and the content does not. Search at the
 * bottom of Profile is the owner's own example of what this fixes.
 *
 * `brand` adds Nomi's owl and name above the title, as the pictures do on
 * Community.
 */
export function TopBar({ title, brand, actions = [] }: { title: string; brand?: boolean; actions?: TopBarAction[] }) {
  const t = useTheme();
  return (
    <View style={{ gap: space.hair }}>
      {brand ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.tight }}>
          <Icon name="nomi" color={t.accent} size={20} />
          <Text style={[type.bodyStrong, { color: t.text }]}>Nomi</Text>
        </View>
      ) : null}
      <View style={styles.titleRow}>
        <Text style={[type.display, { color: t.text, flex: 1 }]} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        {actions.length > 0 ? (
          // The last icon's own padding pulled back, so it lines up with the
          // column's right edge the way the title lines up with its left.
          <View style={{ flexDirection: 'row', marginRight: -space.sm }}>
            {actions.map((a) => (
              <IconButton key={a.label} icon={a.icon} label={a.label} onPress={a.onPress} badge={a.badge} />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * An icon that is a button: a full 44 pt target, the icon centred in it.
 *
 * The label is what a screen reader says and what the probes press — an icon
 * never stands alone for either. With a badge, the label says the count too.
 */
export function IconButton({
  icon,
  label,
  onPress,
  color,
  badge,
  filled,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  color?: string;
  badge?: string | null;
  filled?: boolean;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}, ${badge} new` : label}
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      style={({ pressed }) => ({
        width: TOUCH_TARGET,
        height: TOUCH_TARGET,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : disabled ? 0.45 : 1,
      })}
    >
      <View>
        <Icon name={icon} color={color ?? t.text} filled={filled} />
        {badge ? <IconBadge label={badge} /> : null}
      </View>
    </Pressable>
  );
}

/** A count on an icon's corner — the Community tab, the messages icon. */
export function IconBadge({ label }: { label: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        position: 'absolute',
        top: -5,
        right: -9,
        minWidth: 18,
        height: 18,
        paddingHorizontal: 4,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: t.accent,
        borderWidth: 2,
        borderColor: t.bg,
      }}
    >
      <Text style={{ color: t.accentText, fontSize: 10, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

/**
 * Rows with a hairline between them — how a list looks now (NOTES §56.3).
 *
 * The redesign's rule: lists are rows with dividers, not a stack of bordered
 * boxes; a card is for something that is a distinct object. `card` puts the
 * rows on one rounded surface instead, as a sheet's choices are.
 *
 * The line is its own View at reduced strength, not a border on each row: the
 * border colour at full strength between every row is the "heavy boxes" look
 * this replaces, and the owner's picture uses a faint one.
 */
export function Rows({ children, card }: { children: ReactNode; card?: boolean }) {
  const t = useTheme();
  const items = Children.toArray(children);
  return (
    <View style={card ? { backgroundColor: t.card, borderRadius: radius.md, overflow: 'hidden' } : undefined}>
      {items.map((child, i) => (
        <Fragment key={i}>
          {i > 0 ? <View style={{ height: 1, backgroundColor: t.border, opacity: 0.6 }} /> : null}
          {child}
        </Fragment>
      ))}
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

export function Body({
  children,
  muted,
  strong,
}: {
  children: ReactNode;
  muted?: boolean;
  /** List-row weight, for a name that has to be picked out of the lines around it. */
  strong?: boolean;
}) {
  const t = useTheme();
  return (
    <Text style={[strong ? type.bodyStrong : styles.body, { color: muted ? t.textMuted : t.text }]}>
      {children}
    </Text>
  );
}

/**
 * A small muted line that says what the block below it is.
 *
 * "Continue where you left off", "Your sets". Smaller than the thing it
 * labels, which is the point: a label as loud as its content is a second
 * heading, and the Continue card used to be all heading — "Continue: <set>" in
 * one body-sized line, with no way to tell the verb from the name.
 */
export function Label({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text style={[type.label, { color: t.textMuted }]} accessibilityRole="header">
      {children}
    </Text>
  );
}

/**
 * A compact control that sits in a heading row, beside a title or a label.
 *
 * The same shape as the Nomi entry point, deliberately: both are "there is
 * something here if you want it", neither is the thing you came to do. A
 * full-width `Button` is reserved for that, one per screen.
 */
export function PillButton({
  label,
  onPress,
  leading,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  /** Drawn before the label — Nomi's face, on the Nomi pill. */
  leading?: ReactNode;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.tight,
        minHeight: TOUCH_TARGET,
        paddingHorizontal: space.md,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.card,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {leading ?? null}
      <Text style={[type.label, { color: t.text }]}>{label}</Text>
    </Pressable>
  );
}

/** A `Label` with an optional control at the far end — a section's heading. */
export function SectionRow({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={[styles.titleRow, action ? null : { minHeight: 0 }]}>
      <Label>{title}</Label>
      {action ?? null}
    </View>
  );
}

export interface Option {
  key: string;
  title: string;
  /** One line saying what choosing it is like. */
  detail: string;
  /** A count worth seeing before choosing, as a chip beside the title. */
  badge?: string;
  onPress: () => void;
}

/**
 * Peers to choose between, as one grouped list.
 *
 * Built for the set screen's study modes. They were three stacked buttons —
 * one filled, two outlined — which said "one action and two lesser ones" about
 * three ways of studying the same cards. A grouped list says "pick one", and
 * each row has room to say what that mode is actually like, which a button
 * label never did.
 */
export function OptionList({ options }: { options: Option[] }) {
  const t = useTheme();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: t.border,
        borderRadius: radius.md,
        backgroundColor: t.card,
        overflow: 'hidden',
      }}
    >
      {options.map((o, i) => (
        <Pressable
          key={o.key}
          accessibilityRole="button"
          // The detail is a sentence with its own full stop; appending ". 2 due"
          // straight after it read "knew it.. 2 due" to a screen reader.
          accessibilityLabel={`${o.title}. ${o.detail.replace(/\.$/, '')}${o.badge ? `. ${o.badge}` : ''}.`}
          onPress={o.onPress}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            minHeight: TOUCH_TARGET,
            paddingVertical: space.md,
            paddingHorizontal: space.lg,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: t.border,
            backgroundColor: pressed ? t.bg : 'transparent',
          })}
        >
          <View style={{ flex: 1, gap: space.hair }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm }}>
              <Text style={[type.bodyStrong, { color: t.text }]}>{o.title}</Text>
              {o.badge ? <Chip tone="accent">{o.badge}</Chip> : null}
            </View>
            <Text style={[type.caption, { color: t.textMuted }]}>{o.detail}</Text>
          </View>
          <Icon name="forward" color={t.textMuted} size={20} />
        </Pressable>
      ))}
    </View>
  );
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
  variant?: 'primary' | 'outline' | 'secondary' | 'danger';
}) {
  const t = useTheme();
  const off = disabled || busy;

  // `danger` is the filled button on a problem panel — "Retry" on red, from the
  // owner's reference (NOTES §37). It takes the primary's place there; it is
  // still the one filled button on the screen.
  const fill = variant === 'primary' ? t.accent : variant === 'danger' ? t.danger : 'transparent';
  const border =
    variant === 'primary' || variant === 'outline' ? t.accent : variant === 'danger' ? t.danger : t.border;
  const label_ =
    variant === 'primary'
      ? t.accentText
      : variant === 'danger'
        ? t.onDanger
        : variant === 'outline'
          ? t.accent
          : t.text;

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
  progress,
}: {
  title: string;
  meta?: string;
  onPress: () => void;
  /**
   * How much of it is done, 0 to 1 — a set's cards known. A thin bar under the
   * meta line, from the owner's reference, where every deck carries one.
   */
  progress?: number;
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
        {progress !== undefined ? (
          <View
            style={{
              height: 4,
              marginTop: space.xs,
              borderRadius: radius.pill,
              backgroundColor: t.border,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`,
                height: '100%',
                borderRadius: radius.pill,
                backgroundColor: t.accent,
              }}
            />
          </View>
        ) : null}
      </View>
      <View style={{ marginLeft: space.md }}>
        <Icon name="forward" color={t.textMuted} size={20} />
      </View>
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
  screenCentered: { flexGrow: 1, justifyContent: 'center' },
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
