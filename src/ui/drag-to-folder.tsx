import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Animated, Platform, View } from 'react-native';
import { radius, useTheme } from './theme';

/**
 * Hold a set, then drag it into a folder (NOTES §48).
 *
 * The owner: *"for faster moving, i want to click and hold to drag the
 * flashcards inside the folder, functioning for both using mouse or using
 * fingers (at mobile). for mobile, add a 1 second delay in order to prevent
 * accidental moving. there should be a 1 vibrate for haptics indicating that
 * you can now move that flashcard to a folder."*
 *
 * ## Pointer events, and the delay chosen by the POINTER, not the platform
 *
 * The first version armed the hold in `onTouchStart` and picked its delay with
 * `Platform.OS === 'web'`. Both were wrong, and caught reading it back before
 * it was ever run:
 *
 *  - a mouse fires no touch events, so a mouse drag could never have started;
 *  - this app ships as a PWA, so on the owner's iPhone `Platform.OS` IS 'web',
 *    and a finger would have got the mouse's quarter-second instead of the
 *    full second he asked for.
 *
 * `pointerdown` carries `pointerType` — 'mouse', 'touch' or 'pen' — which is
 * the fact that actually decides it. A mouse gets 250ms, because a mouse
 * resting on a row is not ambiguous and a full second of holding its button
 * feels like the page froze. A finger gets 1000ms, because a finger resting on
 * a list is how somebody starts to scroll.
 *
 * ## Web only, deliberately
 *
 * There is no native build of this app (spec §5: it ships as a web app and an
 * installed PWA). The drag is built on the DOM — window-level pointer listeners,
 * `getBoundingClientRect`, a non-passive `touchmove` — because that is the only
 * way to stop a phone scrolling the list under a finger that is carrying a
 * set. On any other platform the rows simply are not draggable, and "Move to
 * folder" on the set does the same job.
 *
 * ## The hold is what keeps scrolling working
 *
 * Nothing is prevented until the hold completes. Before then the finger is an
 * ordinary finger: moving it more than a few points cancels the hold and the
 * list scrolls exactly as it always did. Only once the set is lifted does a
 * `touchmove` listener start refusing the page's scroll, and it is removed the
 * moment the set is dropped.
 */

/** How long to hold before a set lifts, by what is holding it. */
export const HOLD_MS = { mouse: 250, touch: 1000, pen: 1000 } as const;

/** How far a pointer may wander during the hold before it counts as a scroll. */
const HOLD_SLOP = 8;

/** After a drop, how long a press on the same row is ignored. */
const CLICK_GUARD_MS = 400;

interface DragState {
  register: (folderId: string, el: HTMLElement | null) => void;
  begin: (setId: string) => void;
  hover: (x: number, y: number) => void;
  end: (drop: boolean) => void;
  over: string | null;
  dragging: string | null;
}

const DragContext = createContext<DragState | null>(null);

/**
 * Holds the drop targets and the drag in progress.
 *
 * One provider around the whole list, because a drag starts on a set row and
 * ends on a folder row and neither can see the other.
 */
export function DragToFolderProvider({
  children,
  onDrop,
}: {
  children: ReactNode;
  /** Called with the set and the folder it was dropped on. */
  onDrop: (setId: string, folderId: string) => void;
}) {
  const targets = useRef(new Map<string, HTMLElement>());
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const overRef = useRef<string | null>(null);
  const draggingRef = useRef<string | null>(null);
  /**
   * The latest `onDrop`, read through a ref so `end` never changes identity.
   *
   * Home passes an inline function, which is new on every render of Home. With
   * it in `end`'s dependencies, every refetch that re-rendered Home produced a
   * new context value mid-drag — and that is how the first working version of
   * this dropped every set the instant it was picked up (NOTES §48).
   */
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const register = useCallback((folderId: string, el: HTMLElement | null) => {
    if (el) targets.current.set(folderId, el);
    else targets.current.delete(folderId);
  }, []);

  const begin = useCallback((setId: string) => {
    draggingRef.current = setId;
    setDragging(setId);
  }, []);

  /**
   * Which folder is under the pointer.
   *
   * Measured NOW, every move, rather than when the rows laid out. A rect
   * recorded at layout is wrong the moment the list scrolls — and on a phone
   * the list has usually scrolled to get the set on screen in the first place.
   * `getBoundingClientRect` and the pointer's clientX/Y are both in viewport
   * coordinates, so they agree however far anything has scrolled.
   */
  const hover = useCallback((x: number, y: number) => {
    let hit: string | null = null;
    for (const [id, el] of targets.current) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        hit = id;
        break;
      }
    }
    if (hit !== overRef.current) {
      overRef.current = hit;
      setOver(hit);
    }
  }, []);

  const end = useCallback((drop: boolean) => {
    const setId = draggingRef.current;
    const folderId = overRef.current;
    draggingRef.current = null;
    overRef.current = null;
    setDragging(null);
    setOver(null);
    if (drop && setId && folderId) onDropRef.current(setId, folderId);
  }, []);

  const value = useMemo(
    () => ({ register, begin, hover, end, over, dragging }),
    [register, begin, hover, end, over, dragging],
  );

  return <DragContext.Provider value={value}>{children}</DragContext.Provider>;
}

/** Null outside a provider, so a row can still be used on a screen with no folders. */
function useDrag(): DragState | null {
  return useContext(DragContext);
}

/** A folder row that a set can be dropped on. */
export function DropFolder({
  folderId,
  children,
}: {
  folderId: string;
  children: (isOver: boolean) => ReactNode;
}) {
  const drag = useDrag();
  const register = drag?.register;

  // react-native-web hands back the DOM element as a View's ref, which is what
  // `getBoundingClientRect` needs at drop time.
  const ref = useCallback(
    (el: unknown) => register?.(folderId, (el as HTMLElement | null) ?? null),
    [register, folderId],
  );

  return (
    <View ref={ref as never} collapsable={false}>
      {children(drag?.over === folderId)}
    </View>
  );
}

/**
 * A set row that can be picked up and dragged.
 *
 * `children` gets `lifted`, so the row can show it has been picked up — which
 * is the ONLY pickup signal an iPhone gets: iOS Safari has never implemented
 * the Vibration API (`src/ui/feedback.ts` measured it), so the buzz asked for
 * fires on Android and nowhere else. It also gets `guard`, which wraps the
 * row's own onPress so letting go of a drag does not also open the set.
 */
export function DraggableSet({
  setId,
  disabled,
  children,
}: {
  setId: string;
  /** No folders to drop into: no reason to allow a pickup. */
  disabled?: boolean;
  /**
   * `overFolder` is the folder under the pointer, or null. The carried card is
   * drawn ON TOP of that folder's row and hides its highlight, so the card
   * itself has to say where it will land.
   */
  children: (
    lifted: boolean,
    guard: (onPress: () => void) => () => void,
    overFolder: string | null,
  ) => ReactNode;
}) {
  const drag = useDrag();
  const t = useTheme();
  /**
   * The drag context, through a ref, so nothing below changes identity when it
   * does. The context value changes on purpose whenever a folder lights up or a
   * set lifts — and the first version had `finish` depend on it, with an
   * unmount effect keyed on `finish`. React runs an effect's cleanup whenever
   * its dependencies change, not only on unmount, so the lift itself changed the
   * context, re-created `finish`, ran the "unmount" cleanup, and ended the drag
   * one frame after it began. Measured: held 700ms, never lifted.
   */
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const [lifted, setLifted] = useState(false);
  const offset = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);
  const isLifted = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  const droppedAt = useRef(0);
  /** Everything added to window/document for this gesture, so all of it comes off. */
  const cleanup = useRef<(() => void) | null>(null);

  const finish = useCallback(
    (drop: boolean) => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      holdTimer.current = null;
      holding.current = false;
      cleanup.current?.();
      cleanup.current = null;
      if (isLifted.current) {
        isLifted.current = false;
        droppedAt.current = Date.now();
        setLifted(false);
        offset.setValue({ x: 0, y: 0 });
        dragRef.current?.end(drop);
      }
    },
    [offset],
  );

  // A row unmounting mid-gesture — the list refreshing after a move — must not
  // leave a listener behind that goes on refusing to let the page scroll.
  // `finish` is stable (it reads everything through refs), so this runs on
  // unmount and ONLY on unmount — see the note on `dragRef`.
  useEffect(() => () => finish(false), [finish]);

  const onPointerDown = useCallback(
    (e: { nativeEvent: PointerEvent }) => {
      const ev = e.nativeEvent;
      const drag = dragRef.current;
      if (!drag || Platform.OS !== 'web') return;
      // Only the main button. A right-click is not a pickup.
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;

      finish(false);
      holding.current = true;
      start.current = { x: ev.clientX, y: ev.clientY };
      const pointerId = ev.pointerId;
      const kind = (ev.pointerType as keyof typeof HOLD_MS) in HOLD_MS ? (ev.pointerType as keyof typeof HOLD_MS) : 'touch';

      // Before the lift: any real movement is a scroll, and letting go is a tap.
      const beforeMove = (m: PointerEvent) => {
        if (m.pointerId !== pointerId) return;
        if (
          Math.abs(m.clientX - start.current.x) > HOLD_SLOP ||
          Math.abs(m.clientY - start.current.y) > HOLD_SLOP
        ) {
          finish(false);
        }
      };
      const beforeUp = (u: PointerEvent) => {
        if (u.pointerId === pointerId) finish(false);
      };
      window.addEventListener('pointermove', beforeMove);
      window.addEventListener('pointerup', beforeUp);
      window.addEventListener('pointercancel', beforeUp);
      cleanup.current = () => {
        window.removeEventListener('pointermove', beforeMove);
        window.removeEventListener('pointerup', beforeUp);
        window.removeEventListener('pointercancel', beforeUp);
      };

      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        if (!holding.current) return;
        cleanup.current?.();

        isLifted.current = true;
        setLifted(true);
        drag.begin(setId);
        drag.hover(start.current.x, start.current.y);
        pickedUp();

        // After the lift: the pointer carries the set, and the page must not
        // scroll out from under it. A non-passive touchmove is the only thing
        // that stops a phone scrolling once a finger is moving.
        const move = (m: PointerEvent) => {
          if (m.pointerId !== pointerId) return;
          offset.setValue({ x: m.clientX - start.current.x, y: m.clientY - start.current.y });
          drag.hover(m.clientX, m.clientY);
        };
        const up = (u: PointerEvent) => {
          if (u.pointerId !== pointerId) return;
          drag.hover(u.clientX, u.clientY);
          finish(true);
        };
        const cancel = (c: PointerEvent) => {
          if (c.pointerId === pointerId) finish(false);
        };
        const noScroll = (t: TouchEvent) => t.preventDefault();
        const noSelect = (s: Event) => s.preventDefault();

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', cancel);
        document.addEventListener('touchmove', noScroll, { passive: false });
        document.addEventListener('selectstart', noSelect);
        cleanup.current = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', cancel);
          document.removeEventListener('touchmove', noScroll);
          document.removeEventListener('selectstart', noSelect);
        };
      }, HOLD_MS[kind]);
    },
    [finish, offset, setId],
  );

  // A long press on Android opens the context menu at about half a second,
  // which is before a finger's full second is up. Refused only while a hold or
  // a drag is under way, so a right-click elsewhere still does what it does.
  const onContextMenu = useCallback((e: { preventDefault: () => void }) => {
    if (holding.current || isLifted.current) e.preventDefault();
  }, []);

  const guard = useCallback(
    (onPress: () => void) => () => {
      // Letting go after a drag lands on the row it started from as often as
      // not, and a press there would open the set the person was trying to
      // move. Anything within a moment of a drop is the drop, not a tap.
      if (Date.now() - droppedAt.current < CLICK_GUARD_MS) return;
      onPress();
    },
    [],
  );

  if (disabled || !drag || Platform.OS !== 'web') {
    return <>{children(false, (onPress) => onPress, null)}</>;
  }

  return (
    <Animated.View
      collapsable={false}
      {...({ onPointerDown, onContextMenu } as object)}
      style={[
        {
          // Carried, not ghosted: a touch smaller, fully opaque, shadowed, and
          // above the rows it passes over. It was 95% opaque at first, and
          // photographed over its folder the two rows' words printed through
          // each other — "Drop it on a folder" across "Drop it in here".
          transform: lifted ? [...offset.getTranslateTransform(), { scale: 0.96 }] : [],
          zIndex: lifted ? 50 : 0,
          opacity: 1,
          // A solid backing in the row's own shape. Opacity 1 on this wrapper
          // was not enough: the row inside is a Pressable drawn at 0.7 while
          // pressed, and the pointer is still down the whole time it is being
          // carried — so the folder underneath showed through regardless.
          // Photographed twice before this was the fix.
          backgroundColor: lifted ? t.bg : 'transparent',
          borderRadius: radius.md,
          shadowColor: '#000',
          shadowOpacity: lifted ? 0.45 : 0,
          shadowRadius: lifted ? 14 : 0,
          shadowOffset: { width: 0, height: lifted ? 8 : 0 },
        },
        // A long press on iOS otherwise brings up the text-selection loupe and
        // the callout, which arrive on top of the lift and look like a fault.
        { userSelect: 'none', WebkitTouchCallout: 'none' } as object,
      ]}
    >
      {children(lifted, guard, lifted ? drag.over : null)}
    </Animated.View>
  );
}

/**
 * One buzz, meaning "you can move it now".
 *
 * Best effort and silent on failure, like everything in `src/ui/feedback.ts`,
 * and for the same reason: nothing may depend on a buzz actually happening.
 * **It does not fire on an iPhone** — iOS Safari has never implemented the
 * Vibration API, which §45 measured — so the lift is the signal there.
 */
function pickedUp(): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(18);
    }
  } catch {
    // A missing buzz is not worth an error.
  }
}
