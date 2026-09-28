import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, PanResponder, Platform, Pressable, Text, View, type GestureResponderEvent } from 'react-native';
import { LoadingState, Notice } from './components';
import { Sheet } from './sheet';
import { RowButton } from './people';
import { Icon } from './glyphs';
import { openPicture, UnreadablePictureError } from './pick-files';
import { space, TOUCH_TARGET, type, useTheme } from './theme';
import {
  clampPlacement,
  cropSquare,
  drawnAt,
  START,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAbout,
  type Placement,
} from '../core/crop';

/**
 * Choosing which part of a photo is your picture (NOTES §63) — the owner:
 * *"there's a circle where you could adjust which part of the picture you
 * wanna see, and have opacity outside the circle so users won't get lost.
 * they should be able to zoom in and zoom out."*
 *
 * The photo under a circle, everything outside it dimmed; drag to move it,
 * pinch (or the mouse wheel, on a computer) to zoom, and a slider with − and +
 * for the same, which is also how a screen reader zooms. The circle is always
 * full (src/core/crop.ts). Save draws just the circle's square, 256 px, as a
 * JPEG — the size the old automatic middle-crop saved.
 */

/** The saved picture's side, in pixels — shown at 88 points at most. */
const SIDE = 256;
/** How much of the square the circle takes: the dimmed ring around it says what is left out. */
const CIRCLE_SHARE = 0.84;
/** One tap of − or +, and one step of the wheel. */
const STEP = 1.2;

export function PhotoCropSheet({
  file,
  onCancel,
  onSave,
}: {
  file: Blob;
  onCancel: () => void;
  /** Hand over the finished picture; the sheet shows it is busy until this settles. */
  onSave: (picture: Blob) => Promise<void>;
}) {
  const t = useTheme();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [box, setBox] = useState(0);
  const [placement, setPlacement] = useState<Placement>(START);

  // Latest values for the gesture handlers, which are made once.
  const live = useRef({ placement: START, width: 1, height: 1, circle: 1 });
  const circle = Math.round(box * CIRCLE_SHARE);
  live.current = { placement, width: img?.naturalWidth ?? 1, height: img?.naturalHeight ?? 1, circle: Math.max(1, circle) };

  // Stable, reading `live`: a gesture handler made anew mid-drag would lose
  // how far the drag had come.
  const place = useCallback((next: Placement) => {
    const { width, height, circle: c } = live.current;
    const kept = clampPlacement(next, width, height, c);
    live.current.placement = kept;
    setPlacement(kept);
  }, []);
  const zoomTo = useCallback((zoom: number) => {
    const { placement: p, width, height, circle: c } = live.current;
    const next = zoomAbout(p, zoom, 0, 0, width, height, c);
    live.current.placement = next;
    setPlacement(next);
  }, []);

  // Open the photo once. An object URL, let go of when the sheet closes.
  useEffect(() => {
    const made = URL.createObjectURL(file);
    setUrl(made);
    let cancelled = false;
    openPicture(made)
      .then((opened) => !cancelled && setImg(opened))
      .catch((err) => !cancelled && setError(err instanceof UnreadablePictureError ? err.message : "Couldn't read that picture. Try another one."));
    return () => {
      cancelled = true;
      URL.revokeObjectURL(made);
    };
  }, [file]);

  // Drag with one finger; pinch with two, from the size the pinch started at.
  const gesture = useRef<{ start: Placement; spread: number | null }>({ start: START, spread: null });
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          gesture.current = { start: live.current.placement, spread: spreadOf(e) };
        },
        onPanResponderMove: (e, g) => {
          const spread = spreadOf(e);
          if (spread !== null) {
            if (gesture.current.spread === null) {
              gesture.current = { start: live.current.placement, spread };
              return;
            }
            const { start } = gesture.current;
            const { width, height, circle: c } = live.current;
            const next = zoomAbout(start, start.zoom * (spread / gesture.current.spread), 0, 0, width, height, c);
            live.current.placement = next;
            setPlacement(next);
            return;
          }
          if (gesture.current.spread !== null) {
            // One finger lifted from a pinch: carry on dragging from here.
            gesture.current = { start: live.current.placement, spread: null };
            return;
          }
          const { start } = gesture.current;
          place({ ...start, x: start.x + g.dx, y: start.y + g.dy });
        },
      }),
    [place],
  );

  // The mouse wheel, on a computer. A native listener, because the page must
  // not scroll while the photo zooms, and only a non-passive one can stop it.
  const frame = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = frame.current as unknown as HTMLElement | null;
    if (!node?.addEventListener) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomTo(live.current.placement.zoom * (e.deltaY < 0 ? STEP : 1 / STEP));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [img, box, zoomTo]);

  async function save() {
    if (!img) return;
    setSaving(true);
    setError(null);
    try {
      const { x, y, side } = cropSquare(live.current.placement, img.naturalWidth, img.naturalHeight, live.current.circle);
      const canvas = document.createElement('canvas');
      canvas.width = SIDE;
      canvas.height = SIDE;
      const g = canvas.getContext('2d');
      if (!g) throw new UnreadablePictureError();
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, SIDE, SIDE);
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, x, y, side, side, 0, 0, SIDE, SIDE);
      const picture = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new UnreadablePictureError())), 'image/jpeg', 0.85),
      );
      await onSave(picture);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that picture just now. Try again in a moment.");
      setSaving(false);
    }
  }

  const drawn = img ? drawnAt(placement, img.naturalWidth, img.naturalHeight, circle) : null;
  // A ring as thick as the square, round the circle: everything outside the
  // circle dimmed, the circle itself clear.
  const ring = box;

  return (
    <Sheet
      onClose={saving ? () => {} : onCancel}
      header={
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: TOUCH_TARGET }}>
          <View style={{ flex: 1, alignItems: 'flex-start' }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={onCancel}
              disabled={saving}
              hitSlop={8}
              style={{ minHeight: TOUCH_TARGET, justifyContent: 'center' }}
            >
              <Text style={[type.body, { color: t.text }]}>Cancel</Text>
            </Pressable>
          </View>
          <Text style={[type.bodyStrong, { color: t.text }]} accessibilityRole="header">
            Edit photo
          </Text>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <RowButton label="Save" primary busy={saving} disabled={!img} onPress={() => void save()} />
          </View>
        </View>
      }
    >
      <Text style={[type.caption, { color: t.textMuted, textAlign: 'center' }]}>
        Drag to move it. Pinch, or use the slider, to zoom.
      </Text>

      <View
        onLayout={(e) => setBox(Math.min(360, Math.floor(e.nativeEvent.layout.width)))}
        style={{ width: '100%', alignItems: 'center' }}
      >
        {box > 0 ? (
          <View
            ref={frame}
            {...pan.panHandlers}
            accessibilityLabel="Your photo in the circle. Drag to move it."
            style={[
              { width: box, height: box, overflow: 'hidden', backgroundColor: '#000000', borderRadius: 12 },
              // The page must not scroll or zoom under a drag or a pinch.
              Platform.OS === 'web' ? ({ touchAction: 'none', cursor: 'grab', userSelect: 'none' } as object) : null,
            ]}
          >
            {url && drawn ? (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: box / 2 + drawn.left,
                  top: box / 2 + drawn.top,
                  width: drawn.width,
                  height: drawn.height,
                }}
              >
                <Image source={{ uri: url }} resizeMode="stretch" style={{ width: '100%', height: '100%' }} />
              </View>
            ) : null}
            {!img && !error ? (
              <View style={{ flex: 1, justifyContent: 'center' }}>
                <LoadingState what="Opening your photo…" />
              </View>
            ) : null}
            {/* Outside the circle, dimmed. */}
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: (box - circle) / 2 - ring,
                top: (box - circle) / 2 - ring,
                width: circle + 2 * ring,
                height: circle + 2 * ring,
                borderRadius: circle / 2 + ring,
                borderWidth: ring,
                borderColor: 'rgba(0, 0, 0, 0.6)',
              }}
            />
            {/* The circle's edge, so it reads on a dark photo too. */}
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: (box - circle) / 2,
                top: (box - circle) / 2,
                width: circle,
                height: circle,
                borderRadius: circle / 2,
                borderWidth: 2,
                borderColor: 'rgba(255, 255, 255, 0.85)',
              }}
            />
          </View>
        ) : null}
      </View>

      <ZoomSlider zoom={placement.zoom} disabled={!img} onZoom={zoomTo} />

      {error ? <Notice tone="error">{error}</Notice> : null}
    </Sheet>
  );
}

/** How far apart two fingers are, or null for one. */
function spreadOf(e: GestureResponderEvent): number | null {
  const touches = e.nativeEvent.touches;
  if (!touches || touches.length < 2) return null;
  const [a, b] = [touches[0]!, touches[1]!];
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) || null;
}

/**
 * − ——●—— +: the zoom, from filling the circle to four times that. Drag the
 * handle or tap along the track; − and + step it; a screen reader adjusts it.
 */
function ZoomSlider({ zoom, disabled, onZoom }: { zoom: number; disabled: boolean; onZoom: (zoom: number) => void }) {
  const t = useTheme();
  const [track, setTrack] = useState(1);
  const size = useRef(1);
  size.current = track;
  const startX = useRef(0);
  const zoomAt = (x: number) => ZOOM_MIN + (Math.min(size.current, Math.max(0, x)) / size.current) * (ZOOM_MAX - ZOOM_MIN);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          startX.current = e.nativeEvent.locationX;
          onZoom(zoomAt(startX.current));
        },
        onPanResponderMove: (_, g) => onZoom(zoomAt(startX.current + g.dx)),
      }),
    // `zoomAt` reads refs only; `onZoom` is stable (`zoomTo`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onZoom],
  );

  const at = ((zoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * track;
  const percent = Math.round(zoom * 100);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, opacity: disabled ? 0.5 : 1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Zoom out"
        onPress={() => onZoom(zoom / STEP)}
        disabled={disabled}
        style={{ width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center' }}
      >
        {/* A minus drawn, like every icon here (NOTES §56.2). */}
        <View style={{ width: 14, height: 2, borderRadius: 1, backgroundColor: t.text }} />
      </Pressable>
      <View
        {...(disabled ? {} : pan.panHandlers)}
        onLayout={(e) => setTrack(Math.max(1, e.nativeEvent.layout.width))}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Zoom"
        accessibilityValue={{ min: ZOOM_MIN * 100, max: ZOOM_MAX * 100, now: percent, text: `${percent}%` }}
        // react-native-web drops accessibilityValue (measured: the slider had a
        // role and a name, and no value), as it drops accessibilityState — so
        // the value is said directly, as the tabs say aria-selected.
        aria-valuemin={ZOOM_MIN * 100}
        aria-valuemax={ZOOM_MAX * 100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%`}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => onZoom(e.nativeEvent.actionName === 'increment' ? zoom * STEP : zoom / STEP)}
        style={[
          { flex: 1, height: TOUCH_TARGET, justifyContent: 'center' },
          Platform.OS === 'web' ? ({ touchAction: 'none', cursor: 'pointer' } as object) : null,
        ]}
      >
        <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: t.border }}>
          <View style={{ width: at, height: 4, borderRadius: 2, backgroundColor: t.accent }} />
        </View>
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: at - 11,
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: t.accent,
            borderWidth: 2,
            borderColor: t.bg,
          }}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Zoom in"
        onPress={() => onZoom(zoom * STEP)}
        disabled={disabled}
        style={{ width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name="plus" color={t.text} size={18} />
      </Pressable>
    </View>
  );
}
