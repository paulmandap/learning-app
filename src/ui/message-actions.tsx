import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Body, Button, Notice } from './components';
import { elevation, radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import { GLYPH } from './glyphs';
import { EMOJI_GROUPS, REACTIONS, type ReactionTally } from '../core/emoji';

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
 * ## What is NOT here
 *
 * **Reply.** It appears in the reference screenshots and was never asked for in
 * words, and it is not a menu item — it is a threading model: a reply needs a
 * parent on the message, a quoted stub above the bubble, and a decision about
 * what happens to a reply whose parent is unsent. Building a button for it
 * would be the easy tenth of it.
 */

export type MessageAction = 'react' | 'edit' | 'unsend-everyone' | 'unsend-me';

/**
 * The bar that appears beside a bubble on a pointer device.
 *
 * `hovered` is decided by the row, because the hover belongs to the whole
 * message and not to these three buttons — controls that appeared only while
 * the mouse was on the controls could never be reached.
 */
export function HoverActions({
  visible,
  mine,
  canEdit,
  onPick,
}: {
  visible: boolean;
  mine: boolean;
  canEdit: boolean;
  onPick: (action: MessageAction) => void;
}) {
  const t = useTheme();
  // Kept mounted and made invisible rather than unmounted: a row that appears
  // on hover must not change the layout when it does, or every message shifts
  // sideways as the mouse moves down the page.
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.hair,
        opacity: visible ? 1 : 0,
        // Unreachable while invisible, so a mouse cannot land on a button it
        // cannot see and a screen reader does not read three phantom controls.
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      <ActionButton label="React" glyph={GLYPH.react} onPress={() => onPick('react')} />
      {mine && canEdit ? (
        <ActionButton label="Edit" glyph={GLYPH.edit} onPress={() => onPick('edit')} />
      ) : null}
      <ActionButton
        label="More"
        glyph={GLYPH.more}
        onPress={() => onPick(mine ? 'unsend-everyone' : 'unsend-me')}
      />
      <View style={{ width: 0, borderColor: t.border }} />
    </View>
  );
}

function ActionButton({
  label,
  glyph,
  onPress,
}: {
  label: string;
  glyph: string;
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
      <Text style={{ color: t.textMuted, fontSize: 15 }}>{glyph}</Text>
    </Pressable>
  );
}

/**
 * The sheet a long press opens, and what "More" opens on a pointer.
 *
 * The reaction row is at the top, where Messenger puts it and where a thumb
 * reaches first, with "+" opening every emoji the app knows.
 */
export function MessageSheet({
  mine,
  canEdit,
  editWindowMinutes,
  busy,
  error,
  onReact,
  onEdit,
  onUnsendEveryone,
  onUnsendMe,
  onClose,
}: {
  mine: boolean;
  canEdit: boolean;
  editWindowMinutes: number;
  busy: boolean;
  error: string | null;
  onReact: (emoji: string) => void;
  onEdit: () => void;
  onUnsendEveryone: () => void;
  onUnsendMe: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const [picking, setPicking] = useState(false);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={[
          {
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.55)',
            justifyContent: 'flex-end',
            zIndex: elevation.float + 1,
          },
          Platform.OS === 'web' ? ({ backdropFilter: 'blur(6px)' } as object) : null,
        ]}
      >
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: t.bg,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderTopWidth: 1,
            borderColor: t.border,
            padding: space.lg,
            gap: space.md,
          }}
        >
          {error ? <Notice tone="error">{error}</Notice> : null}

          {/* The six, then "+". */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {REACTIONS.map((r) => (
              <Pressable
                key={r.emoji}
                accessibilityRole="button"
                accessibilityLabel={r.label}
                onPress={() => onReact(r.emoji)}
                style={({ pressed }) => ({
                  width: 46,
                  height: 46,
                  borderRadius: 23,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: pressed ? t.card : 'transparent',
                  borderWidth: 1,
                  borderColor: t.border,
                })}
              >
                <Text style={{ fontSize: 24 }}>{r.emoji}</Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Another emoji"
              accessibilityState={{ expanded: picking }}
              onPress={() => setPicking((p) => !p)}
              style={({ pressed }) => ({
                width: 46,
                height: 46,
                borderRadius: 23,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed || picking ? t.card : 'transparent',
                borderWidth: 1,
                borderColor: picking ? t.accent : t.border,
              })}
            >
              <Text style={{ color: t.text, fontSize: 22 }}>+</Text>
            </Pressable>
          </View>

          {picking ? (
            <ScrollView style={{ maxHeight: 180 }} keyboardShouldPersistTaps="handled">
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
                        style={{
                          width: TOUCH_TARGET,
                          height: TOUCH_TARGET,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Text style={{ fontSize: 22 }}>{e}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ))}
            </ScrollView>
          ) : null}

          {mine && canEdit ? <Button label="Edit message" variant="secondary" onPress={onEdit} disabled={busy} /> : null}
          {mine && !canEdit ? (
            <Body muted>
              A message can only be edited for {editWindowMinutes} minutes after it is sent.
            </Body>
          ) : null}

          {mine ? (
            <>
              <Button label="Unsend for everyone" onPress={onUnsendEveryone} busy={busy} />
              <Button label="Unsend for me only" variant="secondary" onPress={onUnsendMe} disabled={busy} />
            </>
          ) : (
            <>
              <Button label="Hide this from my screen" onPress={onUnsendMe} busy={busy} />
              <Body muted>
                It stays in the room for everyone else — only the person who sent it can take it back.
              </Body>
            </>
          )}

          <Button label="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * The reaction chips under a bubble.
 *
 * One chip per distinct emoji with a count, the way a messenger shows them —
 * six hearts is "❤️ 6", and it is the count that says how a room felt. Tapping
 * one you left takes it back; tapping one you did not adds yours.
 */
export function ReactionChips({
  tallies,
  alignEnd,
  onToggle,
}: {
  tallies: ReactionTally[];
  alignEnd: boolean;
  onToggle: (emoji: string, on: boolean) => void;
}) {
  const t = useTheme();
  if (tallies.length === 0) return null;

  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.hair,
        justifyContent: alignEnd ? 'flex-end' : 'flex-start',
        marginTop: -2,
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
            paddingHorizontal: 7,
            paddingVertical: 2,
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
