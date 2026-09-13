import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { useReducedMotion } from './motion';

/**
 * A bar that grows to its value — up for a column, right for a row.
 *
 * The owner, on Progress: *"everything is like a horizontal bar chart. it feels
 * so static"* (NOTES §37). Columns answered the first half; this answers the
 * second. Each bar grows from nothing when the screen opens and to its new
 * value when the numbers change, a little after the one before it.
 *
 * Height and width cannot be native-driven, the same trade `ProgressBar` makes:
 * a handful of bars for half a second. Under reduced motion a bar is simply its
 * value.
 */
export function GrowBar({
  share,
  color,
  direction,
  length,
  thickness,
  corner = 3,
  delay = 0,
}: {
  /** 0 to 1 of the full length. */
  share: number;
  color: string;
  direction: 'up' | 'right';
  /** The full length of an upward bar, in points. A rightward bar fills its parent. */
  length?: number;
  thickness: number;
  corner?: number;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  const target = Math.max(0, Math.min(1, Number.isFinite(share) ? share : 0));
  const grown = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduce === null) return;
    if (reduce) {
      grown.setValue(target);
      return;
    }
    const animation = Animated.timing(grown, {
      toValue: target,
      duration: 520,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [target, reduce, delay, grown]);

  if (direction === 'up') {
    return (
      <Animated.View
        style={{
          width: thickness,
          height: grown.interpolate({ inputRange: [0, 1], outputRange: [0, length ?? 0] }),
          backgroundColor: color,
          borderTopLeftRadius: corner,
          borderTopRightRadius: corner,
        }}
      />
    );
  }
  return (
    <Animated.View
      style={{
        height: thickness,
        width: grown.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
        backgroundColor: color,
        borderRadius: corner,
      }}
    />
  );
}
