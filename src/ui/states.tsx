import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Platform, Text, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { Button } from './components';
import { useReducedMotion } from './motion';
import { radius, space, type, useTheme } from './theme';

/**
 * Three moments every screen has, drawn one way (NOTES §37).
 *
 * From the owner's reference sheet: *"Generating Flashcards"* with a spinner,
 * *"Could Not Generate"* on a pale red panel with a warning sign and Retry, and
 * *"Add your first notes to begin"* with a drawing of a note and a pencil. They
 * were a bordered card of plain sentences, and a failure was an amber strip
 * inside the same card that said "making cards" — the screen said two opposite
 * things at once.
 *
 * Each is a picture, one line saying what is happening, one saying what it
 * means, and at most one thing to do. The pictures are drawn from Views, like
 * the tab icons and the faces: no image files, no icon font, the same on every
 * device, and in the theme's own colours in both modes.
 */

export type StateKind = 'working' | 'problem' | 'empty';

export interface StateAction {
  label: string;
  onPress: () => void;
  busy?: boolean;
}

const NATIVE = Platform.OS !== 'web';

export function StatePanel({
  kind,
  title,
  detail,
  action,
  secondary,
  picture,
}: {
  kind: StateKind;
  title: string;
  detail?: string;
  /**
   * In place of the kind's own drawing — Nomi reading your notes with a
   * magnifying glass, or writing your cards with a pencil (NOTES §50).
   */
  picture?: ReactNode;
  /** The one filled button: red on a problem, the accent otherwise. */
  action?: StateAction;
  /** A quieter second choice, when there genuinely is one. */
  secondary?: StateAction;
}) {
  const t = useTheme();
  const problem = kind === 'problem';

  return (
    <View
      accessibilityRole={problem ? 'alert' : undefined}
      style={{
        alignItems: 'center',
        gap: space.md,
        paddingVertical: space.xl,
        paddingHorizontal: space.lg,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: problem ? t.dangerBg : t.card,
      }}
    >
      <View
        style={{ height: 88, alignItems: 'center', justifyContent: 'center' }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {picture ?? (kind === 'working' ? <Spinner /> : problem ? <WarningSign /> : <NoteAndPencil />)}
      </View>
      <Text style={[type.title, { color: t.text, textAlign: 'center' }]}>{title}</Text>
      {detail ? <Text style={[type.body, { color: t.textMuted, textAlign: 'center' }]}>{detail}</Text> : null}
      {action || secondary ? (
        <View style={{ alignSelf: 'stretch', gap: space.sm, marginTop: space.sm }}>
          {action ? (
            <Button
              label={action.label}
              onPress={action.onPress}
              busy={action.busy}
              variant={problem ? 'danger' : 'primary'}
            />
          ) : null}
          {secondary ? (
            <Button label={secondary.label} onPress={secondary.onPress} busy={secondary.busy} variant="secondary" />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A ring of dots turning — the reference's "Generating" mark.
 *
 * Transform only, native-driven where there is a native driver. Still when the
 * screen is not in front or reduced motion is on: the ring then reads as a
 * ring, and the title still says what is happening.
 */
function Spinner() {
  const t = useTheme();
  const reduce = useReducedMotion();
  const focused = useIsFocused();
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduce !== false || !focused) return;
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: NATIVE }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, focused, spin]);

  const size = 60;
  const dot = 9;
  const r = (size - dot) / 2;
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
      {Array.from({ length: 8 }, (_, i) => {
        const angle = (i / 8) * Math.PI * 2;
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: r + r * Math.cos(angle),
              top: r + r * Math.sin(angle),
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: t.accent,
              // A tail of fading dots is what makes a ring read as turning.
              opacity: 0.2 + (0.8 * i) / 7,
            }}
          />
        );
      })}
    </Animated.View>
  );
}

/** A warning triangle with its "!", drawn rather than typed. */
function WarningSign() {
  const t = useTheme();
  const w = 70;
  const h = 60;
  return (
    <View style={{ width: w, height: h, alignItems: 'center' }}>
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: w / 2,
          borderRightWidth: w / 2,
          borderBottomWidth: h,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderBottomColor: t.danger,
        }}
      />
      <View style={{ position: 'absolute', top: 20, width: 7, height: 22, borderRadius: 4, backgroundColor: t.dangerBg }} />
      <View style={{ position: 'absolute', top: 46, width: 7, height: 7, borderRadius: 4, backgroundColor: t.dangerBg }} />
    </View>
  );
}

/** A note with lines on it, and a pencil leaning on the corner. */
function NoteAndPencil() {
  const t = useTheme();
  return (
    <View style={{ width: 100, height: 88 }}>
      <View
        style={{
          position: 'absolute',
          left: 10,
          top: 6,
          width: 78,
          height: 78,
          borderRadius: 39,
          backgroundColor: t.infoBg,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 22,
          top: 10,
          width: 50,
          height: 64,
          borderRadius: radius.sm,
          borderWidth: 2,
          borderColor: t.accent,
          backgroundColor: t.card,
          paddingTop: space.md,
          paddingHorizontal: space.sm,
          gap: space.tight,
        }}
      >
        {[1, 0.8, 1, 0.55].map((share, i) => (
          <View
            key={i}
            style={{ height: 3, width: `${share * 100}%`, borderRadius: 2, backgroundColor: t.border }}
          />
        ))}
      </View>
      <View style={{ position: 'absolute', left: 64, top: 24, width: 12, height: 52, transform: [{ rotate: '35deg' }] }}>
        <View
          style={{ height: 8, borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: t.chart.tricky }}
        />
        <View style={{ flex: 1, backgroundColor: t.accent }} />
        <View
          style={{
            alignSelf: 'center',
            width: 0,
            height: 0,
            borderLeftWidth: 6,
            borderRightWidth: 6,
            borderTopWidth: 9,
            borderLeftColor: 'transparent',
            borderRightColor: 'transparent',
            borderTopColor: t.textMuted,
          }}
        />
      </View>
    </View>
  );
}
