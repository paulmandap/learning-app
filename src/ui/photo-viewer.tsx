import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Image, PanResponder, Platform, Pressable, Text, View, type GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullScreen } from './sheet';
import { Icon } from './glyphs';
import { CONTENT_MAX_WIDTH, space, TOUCH_TARGET, type } from './theme';
import {
  clampView,
  doubleTap,
  VIEW_START,
  VIEW_ZOOM_MAX,
  VIEW_ZOOM_MIN,
  viewDrawn,
  zoomViewAbout,
  type ViewPlacement,
} from '../core/photo-view';

/**
 * A post's photo, the whole screen, to look at up close (NOTES §65).
 *
 * The owner: *"when i see the post with a picture, i can't click on the
 * picture. i want it to work like facebook where after clicking the picture,
 * i can zoom in zoom out, the like comment share can still be seen at the
 * bottom part."*
 *
 * So, as Facebook draws it: black all round, ✕ at the top left and − + at the
 * top right; the photo whole in the middle; and at the bottom who posted it,
 * their words, and the post's own heart, comments and share — passed in as
 * `actions`, so they are the very buttons under the post and do the same.
 *
 * Zoom with a pinch, the mouse wheel, − and +, the keyboard's − + and 0, or a
 * double tap (in where you tapped, or back out). Zoomed, a drag moves it; at
 * its whole size, a drag down or up puts it away. The numbers are
 * src/core/photo-view.ts.
 */

/** One tap of − or +, one step of the wheel. */
const STEP = 1.25;
/** How far a drag at the whole size must go to put the photo away. */
const DISMISS_DRAG = 110;
/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 30;
/** A press that moved less than this is a tap, not a drag. */
const TAP_SLOP = 8;

const WHITE = '#ffffff';
const WHITE_MUTED = 'rgba(255, 255, 255, 0.72)';

export function PhotoViewer({
  uri,
  width,
  height,
  name,
  detail,
  words,
  actions,
  onClose,
}: {
  uri: string;
  /** The photo's own size, when the post knows it. */
  width: number | null;
  height: number | null;
  /** Who posted it, and "@user · 2h" under that. */
  name: string;
  detail: string;
  /** The post's words, if it has any. */
  words: string;
  /** The heart, comments and share — the post's own. */
  actions: ReactNode;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    width && height ? { width, height } : null,
  );
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const [placement, setPlacement] = useState<ViewPlacement>(VIEW_START);
  const [wordsOpen, setWordsOpen] = useState(false);

  // A post from before its size was recorded: ask the picture.
  useEffect(() => {
    if (size) return;
    Image.getSize(
      uri,
      (w, h) => setSize({ width: w, height: h }),
      () => setSize({ width: 4, height: 3 }),
    );
  }, [uri, size]);

  // Latest values for the gesture handlers, which are made once.
  const live = useRef({ placement: VIEW_START, dims: { width: 1, height: 1, frameWidth: 1, frameHeight: 1 } });
  live.current = {
    placement,
    dims: {
      width: size?.width ?? 1,
      height: size?.height ?? 1,
      frameWidth: frame?.width ?? 1,
      frameHeight: frame?.height ?? 1,
    },
  };
  const set = useCallback((next: ViewPlacement) => {
    live.current.placement = next;
    setPlacement(next);
  }, []);
  /** Zoom about a point given from the frame's centre; the buttons use the centre. */
  const zoomTo = useCallback(
    (zoom: number, px = 0, py = 0) => set(zoomViewAbout(live.current.placement, zoom, px, py, live.current.dims)),
    [set],
  );

  // Where the frame is on screen, so a finger or the pointer can be turned
  // into a point from its centre.
  const stage = useRef<View>(null);
  const origin = useRef({ x: 0, y: 0 });
  const fromCentre = (pageX: number, pageY: number) => ({
    px: pageX - origin.current.x - live.current.dims.frameWidth / 2,
    py: pageY - origin.current.y - live.current.dims.frameHeight / 2,
  });

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const gesture = useRef({
    start: VIEW_START,
    spread: null as number | null,
    at: 0,
    x: 0,
    y: 0,
    moved: false,
    /** A pinch happened in this gesture: letting go never puts the photo away. */
    pinched: false,
    lastTap: { at: 0, x: 0, y: 0 },
  });
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          const g = gesture.current;
          g.start = live.current.placement;
          g.spread = spreadOf(e);
          g.at = Date.now();
          g.x = e.nativeEvent.pageX;
          g.y = e.nativeEvent.pageY;
          g.moved = false;
          g.pinched = false;
        },
        onPanResponderMove: (e, d) => {
          const g = gesture.current;
          if (Math.abs(d.dx) > TAP_SLOP || Math.abs(d.dy) > TAP_SLOP) g.moved = true;
          const spread = spreadOf(e);
          if (spread !== null) {
            g.moved = true;
            g.pinched = true;
            if (g.spread === null) {
              g.start = live.current.placement;
              g.spread = spread;
              return;
            }
            const mid = midOf(e);
            const { px, py } = mid ? fromCentre(mid.x, mid.y) : { px: 0, py: 0 };
            set(zoomViewAbout(g.start, g.start.zoom * (spread / g.spread), px, py, live.current.dims));
            return;
          }
          if (g.spread !== null) {
            // One finger lifted from a pinch: carry on dragging from here.
            g.start = live.current.placement;
            g.spread = null;
            return;
          }
          if (g.start.zoom > VIEW_ZOOM_MIN) {
            set(clampView({ ...g.start, x: g.start.x + d.dx, y: g.start.y + d.dy }, live.current.dims));
          } else {
            // The whole photo follows the finger up or down, to be put away.
            set({ ...VIEW_START, y: d.dy });
          }
        },
        onPanResponderRelease: (_, d) => {
          const g = gesture.current;
          if (!g.moved && Date.now() - g.at < 250) {
            const last = g.lastTap;
            const now = Date.now();
            if (now - last.at < DOUBLE_TAP_MS && Math.hypot(g.x - last.x, g.y - last.y) < DOUBLE_TAP_SLOP) {
              const { px, py } = fromCentre(g.x, g.y);
              set(doubleTap(live.current.placement, px, py, live.current.dims));
              g.lastTap = { at: 0, x: 0, y: 0 };
            } else {
              g.lastTap = { at: now, x: g.x, y: g.y };
            }
            return;
          }
          if (g.pinched) {
            set(clampView(live.current.placement, live.current.dims));
          } else if (g.start.zoom <= VIEW_ZOOM_MIN) {
            if (Math.abs(d.dy) > DISMISS_DRAG && Math.abs(d.dy) > Math.abs(d.dx)) onCloseRef.current();
            else set(VIEW_START);
          }
        },
      }),
    // `fromCentre` reads refs only; `set` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [set],
  );

  // The mouse wheel and the keyboard, on a computer. A native listener for the
  // wheel, because the page under it must not scroll, and only a non-passive
  // one can stop that.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = stage.current as unknown as HTMLElement | null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = node!.getBoundingClientRect();
      zoomTo(
        live.current.placement.zoom * (e.deltaY < 0 ? STEP : 1 / STEP),
        e.clientX - rect.left - rect.width / 2,
        e.clientY - rect.top - rect.height / 2,
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') zoomTo(live.current.placement.zoom * STEP);
      else if (e.key === '-' || e.key === '_') zoomTo(live.current.placement.zoom / STEP);
      else if (e.key === '0') set(VIEW_START);
    };
    node?.addEventListener?.('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      node?.removeEventListener?.('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, [frame, zoomTo, set]);

  const drawn = size && frame ? viewDrawn(placement, live.current.dims) : null;
  const percent = Math.round(placement.zoom * 100);

  return (
    <FullScreen onClose={onClose}>
      <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom + space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.sm, minHeight: TOUCH_TARGET + space.sm }}>
          <BarButton label="Close the photo" onPress={onClose}>
            <Icon name="close" color={WHITE} size={24} />
          </BarButton>
          <View style={{ flex: 1 }} />
          <BarButton label="Zoom out" onPress={() => zoomTo(placement.zoom / STEP)} disabled={placement.zoom <= VIEW_ZOOM_MIN}>
            {/* A minus drawn, like every icon here (NOTES §56.2). */}
            <View style={{ width: 16, height: 2, borderRadius: 1, backgroundColor: WHITE }} />
          </BarButton>
          <Text
            style={[type.caption, { color: WHITE_MUTED, minWidth: 44, textAlign: 'center' }]}
            accessibilityLabel={`Zoomed to ${percent}%`}
          >
            {`${percent}%`}
          </Text>
          <BarButton label="Zoom in" onPress={() => zoomTo(placement.zoom * STEP)} disabled={placement.zoom >= VIEW_ZOOM_MAX}>
            <Icon name="plus" color={WHITE} size={22} />
          </BarButton>
        </View>

        <View
          ref={stage}
          {...pan.panHandlers}
          accessibilityLabel="The photo. Pinch or double tap to zoom; drag to move it."
          onLayout={(e) => {
            const { width: w, height: h } = e.nativeEvent.layout;
            setFrame({ width: w, height: h });
            stage.current?.measureInWindow((x, y) => {
              origin.current = { x, y };
            });
          }}
          style={[
            { flex: 1, overflow: 'hidden' },
            // The page must not scroll or zoom under a drag or a pinch.
            Platform.OS === 'web'
              ? ({ touchAction: 'none', userSelect: 'none', cursor: placement.zoom > VIEW_ZOOM_MIN ? 'grab' : 'zoom-in' } as object)
              : null,
          ]}
        >
          {drawn && frame ? (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: frame.width / 2 + drawn.left,
                top: frame.height / 2 + drawn.top,
                width: drawn.width,
                height: drawn.height,
              }}
            >
              <Image source={{ uri }} resizeMode="stretch" style={{ width: '100%', height: '100%' }} accessibilityLabel="Photo" />
            </View>
          ) : null}
        </View>

        <View
          style={{
            width: '100%',
            maxWidth: CONTENT_MAX_WIDTH + 2 * space.lg,
            alignSelf: 'center',
            paddingHorizontal: space.lg,
            paddingTop: space.md,
            gap: space.xs,
          }}
        >
          <Text style={[type.bodyStrong, { color: WHITE }]} numberOfLines={1}>
            {name}
          </Text>
          {detail ? (
            <Text style={[type.caption, { color: WHITE_MUTED }]} numberOfLines={1}>
              {detail}
            </Text>
          ) : null}
          {words ? (
            <Text
              style={[type.body, { color: WHITE }]}
              numberOfLines={wordsOpen ? undefined : 2}
              onPress={() => setWordsOpen((o) => !o)}
            >
              {words}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg, marginLeft: -space.sm }}>{actions}</View>
        </View>
      </View>
    </FullScreen>
  );
}

function BarButton({
  label,
  onPress,
  disabled,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      style={({ pressed }) => ({
        width: TOUCH_TARGET,
        height: TOUCH_TARGET,
        borderRadius: TOUCH_TARGET / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? 'rgba(255, 255, 255, 0.16)' : 'transparent',
        opacity: disabled ? 0.35 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

/** How far apart two fingers are, or null for one. */
function spreadOf(e: GestureResponderEvent): number | null {
  const touches = e.nativeEvent.touches;
  if (!touches || touches.length < 2) return null;
  const [a, b] = [touches[0]!, touches[1]!];
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) || null;
}

/** The point between two fingers, on the page. */
function midOf(e: GestureResponderEvent): { x: number; y: number } | null {
  const touches = e.nativeEvent.touches;
  if (!touches || touches.length < 2) return null;
  const [a, b] = [touches[0]!, touches[1]!];
  return { x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 };
}
