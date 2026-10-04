import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Button, Notice } from './components';
import { Popover, Sheet, SheetActions, SheetTitle } from './sheet';
import { radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import { Icon, type IconName } from './glyphs';
import { EMOJI_GROUPS, REACTIONS, type ReactionTally } from '../core/emoji';
import type { Anchor } from '../core/popover';

/**
 * What you can do to a message (NOTES §48).
 *
 * The owner, with Messenger screenshots: *"two options to unsend a message: 1
 * having 3 dots or click and hold (only for the mobile) to unsend the message.
 * ... when my mouse is not hovering that chat, nothing appears. once i hover,
 * those 3 dots, reply, and react will appear. for mobile, when click and hold,
 * that will appear."*
 *
 * ## Two ways in, because there are two kinds of device
 *
 * On a pointer, the controls appear beside the bubble on hover and vanish when
 * the mouse leaves — a row of buttons under every message would be the clutter
 * he asked to remove from the old screen. On a touch device there is no hover,
 * so a long press opens the same choices as a sheet.
 *
 * Both routes end in this component; only the way it is summoned differs.
 *
 * ## Reply, since NOTES §58
 *
 * It was left out in §48 as "not a menu item — a threading model: a parent on
 * the message, a quoted stub above the bubble, and a decision about what
 * happens to a reply whose parent is unsent." The owner asked for it with the
 * redesign, and 0032 is that model: `reply_to` on each kind of message, the
 * quote in the rooms' views, and a reply that outlives an unsent parent and
 * says "Message removed". The button is the last tenth.
 *
 * ## React, Reply, More — three different things (NOTES §65)
 *
 * The emoji and the ⋯ both opened this sheet. The owner: they *"serve the
 * same purpose. when i click on emoji, it should look like that too just like
 * messenger"*, with Messenger's picture: 😊 ↩ ⋮ beside the bubble. So the
 * emoji opens a bar of reactions over the message (`ReactionPopover`), the
 * arrow answers it straight away, and ⋯ opens the sheet of everything else —
 * without the reactions, which the emoji has. A long press on a phone still
 * opens the sheet with the reactions at the top: it is the one way in there.
 */

/**
 * The bar that appears beside a bubble on a pointer device: 😊 ↩ ⋯ reading
 * outwards from the bubble, on either side, as Messenger draws it.
 *
 * `hovered` is decided by the row, because the hover belongs to the whole
 * message and not to these three buttons — controls that appeared only while
 * the mouse was on the controls could never be reached.
 */
export function HoverActions({
  visible,
  mine,
  onReact,
  onReply,
  onMore,
}: {
  visible: boolean;
  mine: boolean;
  onReact: () => void;
  /** Absent where nothing can be sent — a closed conversation. */
  onReply?: () => void;
  onMore: () => void;
}) {
  // Kept mounted and made invisible rather than unmounted: a row that appears
  // on hover must not change the layout when it does, or every message shifts
  // sideways as the mouse moves down the page.
  return (
    <View
      style={{
        // Yours sit to the left of your bubble, so the order turns round:
        // the emoji is always the one nearest the words.
        flexDirection: mine ? 'row-reverse' : 'row',
        alignItems: 'center',
        gap: space.hair,
        opacity: visible ? 1 : 0,
        // Unreachable while invisible, so a mouse cannot land on a button it
        // cannot see and a screen reader does not read three phantom controls.
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      <ActionButton label="React" icon="emoji" onPress={onReact} />
      {onReply ? <ActionButton label="Reply" icon="reply" onPress={onReply} /> : null}
      <ActionButton label="More" icon="more" onPress={onMore} />
    </View>
  );
}

/**
 * Messenger's reaction bar: the six over the message, and "+" for every other
 * emoji (NOTES §65). Opened by the 😊 beside a bubble; closes on a pick.
 */
export const REACTION_BAR_WIDTH = (REACTIONS.length + 1) * 40 + 2 * space.xs + 2;

export function ReactionPopover({
  anchor,
  mine,
  onReact,
  onClose,
}: {
  anchor: Anchor;
  /** Your message: the bar lines up with the bubble's right edge. */
  mine: boolean;
  onReact: (emoji: string) => void;
  onClose: () => void;
}) {
  return (
    <Popover
      anchor={anchor}
      width={REACTION_BAR_WIDTH}
      height={260}
      side={mine ? 'end' : 'start'}
      label="Reactions"
      onClose={onClose}
    >
      <ReactionRow onReact={onReact} more compact />
    </Popover>
  );
}

function ActionButton({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? t.card : 'transparent',
      })}
    >
      <Icon name={icon} color={t.textMuted} size={18} />
    </Pressable>
  );
}

/**
 * The sheet a long press opens, and what "More" opens on a pointer.
 *
 * With `reactions` (a long press), the reaction row is at the top, where
 * Messenger puts it and where a thumb reaches first, with "+" opening every
 * emoji the app knows. From ⋯ it is left out: the 😊 beside it has them.
 *
 * ## One Unsend, then who for (NOTES §65)
 *
 * It offered "Unsend for everyone" and "Unsend for me only" side by side, and
 * "Hide this from my screen" on somebody else's message. The owner: *"it's
 * better if it's just unsend. then after clicking unsend, it has two options:
 * unsend for me, or unsend for everyone (this only applicable to me as the
 * sender of my message -- just like messenger)."* So one Unsend in the list,
 * and the choice on the next page of the same sheet — which is also the
 * confirming step, so nothing is gone on one tap.
 */
export function MessageSheet({
  mine,
  canEdit,
  editWindowMinutes,
  busy,
  error,
  reactions = true,
  onReact,
  onReply,
  onCopy,
  onEdit,
  onUnsendEveryone,
  onUnsendMe,
  hideDetail = 'It stays in the room for everyone else — only the person who sent it can take it back.',
  name,
  onViewProfile,
  onReport,
  onBlock,
  onClose,
}: {
  mine: boolean;
  canEdit: boolean;
  editWindowMinutes: number;
  busy: boolean;
  error: string | null;
  /** The reaction row at the top — for a long press, not for ⋯. */
  reactions?: boolean;
  onReact: (emoji: string) => void;
  /** Answer it (NOTES §58). Absent where nothing can be sent — a closed conversation. */
  onReply?: () => void;
  /**
   * Its words to the clipboard (NOTES §72). A bubble's words are not selectable
   * any more — holding it is for this sheet — so this is how they are copied.
   * Absent when the message has no words, only a post.
   */
  onCopy?: () => void;
  onEdit: () => void;
  onUnsendEveryone: () => void;
  onUnsendMe: () => void;
  /** Under "Unsend for me" on somebody else's message, in the room's words (NOTES §53). */
  hideDetail?: string;
  /** Who sent it, for "Block Paul". Somebody else's message only (NOTES §51). */
  name?: string;
  onViewProfile?: () => void;
  onReport?: () => void;
  onBlock?: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const [unsending, setUnsending] = useState(false);

  if (unsending) {
    return (
      <Sheet onClose={onClose}>
        <SheetTitle>{mine ? 'Who do you want to unsend this for?' : 'Unsend this message?'}</SheetTitle>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <SheetActions
          actions={[
            mine
              ? {
                  icon: 'trash',
                  label: 'Unsend for everyone',
                  detail: 'Nobody in the chat sees it any more.',
                  onPress: onUnsendEveryone,
                  destructive: true,
                  disabled: busy,
                }
              : null,
            {
              icon: 'hide',
              label: 'Unsend for me',
              detail: mine ? 'Gone from your screen. Everyone else still sees it.' : hideDetail,
              onPress: onUnsendMe,
              disabled: busy,
            },
          ]}
        />
        <Button label="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
      </Sheet>
    );
  }

  // The owner's picture: the reactions in a row of their own, then one list of
  // what can be done, each with its icon — no stack of full-width buttons.
  // Report and Block in the danger colour (NOTES §51).
  return (
    <Sheet onClose={onClose}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {reactions ? <ReactionRow onReact={onReact} disabled={busy} more /> : null}
      <SheetActions
        actions={
          mine
            ? [
                onReply ? { icon: 'reply', label: 'Reply', onPress: onReply, disabled: busy } : null,
                onCopy ? { icon: 'notes', label: 'Copy', onPress: onCopy, disabled: busy } : null,
                canEdit ? { icon: 'edit', label: 'Edit message', onPress: onEdit, disabled: busy } : null,
                { icon: 'trash', label: 'Unsend', onPress: () => setUnsending(true), disabled: busy },
              ]
            : [
                onReply ? { icon: 'reply', label: 'Reply', onPress: onReply, disabled: busy } : null,
                onCopy ? { icon: 'notes', label: 'Copy', onPress: onCopy, disabled: busy } : null,
                { icon: 'trash', label: 'Unsend', onPress: () => setUnsending(true), disabled: busy },
                onViewProfile && name
                  ? { icon: 'person', label: `See ${name}'s profile`, onPress: onViewProfile, disabled: busy }
                  : null,
                onReport
                  ? { icon: 'report', label: 'Report this message', onPress: onReport, destructive: true, disabled: busy }
                  : null,
                onBlock && name
                  ? { icon: 'block', label: `Block ${name}`, onPress: onBlock, destructive: true, disabled: busy }
                  : null,
              ]
        }
      />
      {mine && !canEdit ? (
        <Text style={[type.caption, { color: t.textMuted }]}>
          A message can only be edited for {editWindowMinutes} minutes after it is sent.
        </Text>
      ) : null}
    </Sheet>
  );
}

/**
 * The six reactions in a row of their own — a message's sheet and a post's —
 * and with `more`, a "+" that opens every emoji the app knows.
 *
 * Each takes an equal share of the row rather than a fixed 46 pt, so all seven
 * fit a 320 pt phone without wrapping to a second line. `compact` is the bar
 * over a message (`ReactionPopover`): 40 pt each, on the popover's own card.
 */
export function ReactionRow({
  onReact,
  disabled,
  more,
  compact = false,
}: {
  onReact: (emoji: string) => void;
  disabled?: boolean;
  more?: boolean;
  compact?: boolean;
}) {
  const t = useTheme();
  const [picking, setPicking] = useState(false);
  const cell = ({ pressed }: { pressed: boolean }) => ({
    ...(compact ? { width: 40, height: 40, borderRadius: 20 } : { flex: 1, height: TOUCH_TARGET, borderRadius: TOUCH_TARGET / 2 }),
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: pressed ? t.bg : 'transparent',
  });

  return (
    <View style={{ gap: space.sm }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: compact ? 0 : space.xs,
          paddingVertical: compact ? 0 : space.xs,
          borderRadius: radius.pill,
          backgroundColor: t.card,
        }}
      >
        {REACTIONS.map((r) => (
          <Pressable
            key={r.emoji}
            accessibilityRole="button"
            accessibilityLabel={r.label}
            onPress={() => onReact(r.emoji)}
            disabled={disabled}
            style={cell}
          >
            <Text style={{ fontSize: compact ? 24 : 26 }}>{r.emoji}</Text>
          </Pressable>
        ))}
        {more ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Another emoji"
            accessibilityState={{ expanded: picking }}
            onPress={() => setPicking((p) => !p)}
            style={(state) => [cell(state), picking ? { backgroundColor: t.bg } : null]}
          >
            <Icon name="plus" color={picking ? t.accent : t.textMuted} size={22} />
          </Pressable>
        ) : null}
      </View>

      {picking ? (
        <ScrollView
          style={{ maxHeight: 180 }}
          contentContainerStyle={compact ? { paddingHorizontal: space.xs } : undefined}
          keyboardShouldPersistTaps="handled"
        >
          {EMOJI_GROUPS.map((group) => (
            <View key={group.label} style={{ gap: space.hair, marginBottom: space.sm }}>
              <Text style={[type.caption, { color: t.textMuted }]}>{group.label}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {group.emoji.map((e) => (
                  <Pressable
                    key={e}
                    accessibilityRole="button"
                    accessibilityLabel={e}
                    onPress={() => onReact(e)}
                    disabled={disabled}
                    style={{ width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Text style={{ fontSize: 22 }}>{e}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

/** A reaction chip's height, and how far it tucks up under the bubble's edge. */
export const CHIP_HEIGHT = 22;
export const CHIP_OVERLAP = 6;
/** How far a message with reactions reaches below its bubble. */
export const CHIP_DROP = CHIP_HEIGHT - CHIP_OVERLAP;

/**
 * The reaction chips on a bubble's bottom edge.
 *
 * One chip per distinct emoji with a count, the way a messenger shows them —
 * six hearts is "❤️ 6", and it is the count that says how a room felt. Tapping
 * one you left takes it back; tapping one you did not adds yours.
 *
 * ## Which corner (NOTES §65)
 *
 * They sat at the page's edge — under your bubble's right end, and under their
 * face on the left. The owner: *"it should be opposite. just like
 * messenger."* So they hang from the bubble's inner corner, the one towards
 * the middle of the screen: the left of yours, the right of theirs, tucked up
 * over its edge.
 */
export function ReactionChips({
  tallies,
  side,
  onToggle,
}: {
  tallies: ReactionTally[];
  /** The bubble's corner they hang from: 'start' is its left. */
  side: 'start' | 'end';
  onToggle: (emoji: string, on: boolean) => void;
}) {
  const t = useTheme();
  if (tallies.length === 0) return null;

  return (
    <View
      style={{
        flexDirection: 'row',
        gap: space.hair,
        alignSelf: side === 'start' ? 'flex-start' : 'flex-end',
        marginTop: -CHIP_OVERLAP,
        marginHorizontal: space.sm,
        zIndex: 1,
      }}
    >
      {tallies.map((tally) => (
        <Pressable
          key={tally.emoji}
          accessibilityRole="button"
          accessibilityState={{ selected: tally.mine }}
          accessibilityLabel={`${tally.emoji} from ${tally.names.join(', ')}. ${
            tally.mine ? 'Tap to take yours back' : 'Tap to react'
          }`}
          onPress={() => onToggle(tally.emoji, !tally.mine)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 3,
            height: CHIP_HEIGHT,
            paddingHorizontal: 7,
            borderRadius: radius.pill,
            borderWidth: 1,
            // Yours is outlined in the accent, so a glance says whether you
            // already reacted — never colour alone, which is why the count also
            // changes weight.
            borderColor: tally.mine ? t.accent : t.border,
            backgroundColor: t.card,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text style={{ fontSize: 13 }}>{tally.emoji}</Text>
          <Text
            style={[
              type.caption,
              { color: tally.mine ? t.accent : t.textMuted, fontWeight: tally.mine ? '700' : '500' },
            ]}
          >
            {tally.count}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * A long press, for the devices that have no hover.
 *
 * Returns handlers for a row to spread. The delay is shorter than the drag's
 * thousand milliseconds on purpose: nothing here is destructive on its own —
 * it opens a menu — whereas picking a set up and dropping it somewhere is, and
 * a menu that takes a full second to arrive feels broken.
 */
export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => cancel, []);

  return {
    onTouchStart: () => {
      cancel();
      timer.current = setTimeout(onLongPress, ms);
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    onTouchMove: cancel,
  };
}
