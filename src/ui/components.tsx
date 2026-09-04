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
import { CONTENT_MAX_WIDTH, radius, space, TOUCH_TARGET, type, useTheme } from './theme';

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

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const t = useTheme();
  return <Text style={[styles.body, { color: muted ? t.textMuted : t.text }]}>{children}</Text>;
}

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
  variant?: 'primary' | 'secondary';
}) {
  const t = useTheme();
  const isPrimary = variant === 'primary';
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={off}
      style={[
        styles.button,
        {
          backgroundColor: isPrimary ? t.accent : 'transparent',
          borderColor: isPrimary ? t.accent : t.border,
          opacity: off ? 0.55 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={isPrimary ? t.accentText : t.text} />
      ) : (
        <Text style={[styles.buttonLabel, { color: isPrimary ? t.accentText : t.text }]}>
          {label}
        </Text>
      )}
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
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboardType?: 'default' | 'email-address' | 'number-pad';
  autoCapitalize?: 'none' | 'sentences';
  maxLength?: number;
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
export function Notice({ tone, children }: { tone: 'ok' | 'error' | 'warn'; children: ReactNode }) {
  const t = useTheme();
  const color = tone === 'ok' ? t.ok : tone === 'error' ? t.danger : t.warnText;
  const bg = tone === 'warn' ? t.warnBg : 'transparent';
  return (
    <View style={[styles.notice, { backgroundColor: bg }]}>
      <Text style={[styles.body, { color }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screenContent: { alignItems: 'center', padding: space.lg, paddingBottom: 48 },
  card: { borderWidth: 1, borderRadius: radius.md, padding: space.lg, gap: space.md },
  title: type.title,
  body: type.body,
  label: type.label,
  input: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: 16,
    minHeight: TOUCH_TARGET,
  },
  button: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 16, fontWeight: '600' },
  notice: { borderRadius: radius.sm, paddingVertical: space.sm, paddingHorizontal: space.md },
});
