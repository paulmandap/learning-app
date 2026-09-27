import { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import { Body, Button, Card, Field, Label, LoadingState, Notice } from './components';
import { StatePanel } from './states';
import { Composer } from './nomi';
import { PersonAvatar } from './avatar';
import { BlockSheet, ReportSheet } from './people';
import { HoverActions, MessageSheet, ReactionChips, useLongPress } from './message-actions';
import { CONTENT_MAX_WIDTH, radius, space, type, useTheme } from './theme';
import { authorName, canEdit, EDIT_WINDOW_MINUTES, MESSAGE_MAX_LENGTH } from '../core/community';
import { describeWhen } from '../core/chat';
import { tallyReactions, type Reaction, type ReactionTally } from '../core/emoji';

/**
 * A room to talk in — the Everyone room, and a conversation with a friend
 * (NOTES §53).
 *
 * Moved out of the Community tab when messages between friends arrived, rather
 * than written twice. Everything the owner asked of the Everyone room over three
 * rounds — Messenger's bubbles (§47), unsending as a choice (§47), reactions,
 * the hover and long-press menu, editing for twenty minutes and never silently
 * (§48), report and block (§51) — a conversation with a friend needs too, and a
 * second copy is how one of them ends up with a one-tap unsend again.
 *
 * What differs is passed in: how to load and write, the words for an empty
 * room, whether names go over the bubbles (not when there are two of you),
 * "Seen" under your last message, and a closed conversation's reason in place
 * of the box to type in.
 */

export interface RoomMessage {
  id: string;
  author_id: string;
  author_name: string | null;
  author_avatar: string | null;
  body: string;
  created_at: string;
  edited_at?: string | null;
}

export interface RoomActions {
  send: (text: string) => Promise<void>;
  edit: (id: string, text: string) => Promise<void>;
  unsendEveryone: (id: string) => Promise<void>;
  hideForMe: (id: string) => Promise<void>;
  react: (id: string, emoji: string, on: boolean) => Promise<void>;
}

export function ChatRoom({
  messages,
  loading,
  myId,
  reactions,
  empty,
  placeholder,
  reportKind,
  showNames,
  seenId = null,
  closed = null,
  hideDetail,
  editNote,
  actions,
  onChanged,
}: {
  messages: readonly RoomMessage[];
  loading: boolean;
  myId: string;
  reactions: readonly Reaction[];
  empty: { title: string; detail: string };
  placeholder: string;
  reportKind: 'message' | 'direct_message';
  /** Names over the first bubble of a run — in a room of many; not between two. */
  showNames: boolean;
  /** The message to say "Seen" under, if any. */
  seenId?: string | null;
  /** Why nothing can be sent here, in place of the box to type in. */
  closed?: string | null;
  /** Under "Hide this from my screen", on somebody else's message. */
  hideDetail: string;
  /** Under the edit box: who will see the "edited" mark. */
  editNote: string;
  actions: RoomActions;
  /** After any write, so the screen refreshes what it holds. */
  onChanged: () => Promise<void>;
}) {
  const t = useTheme();
  const router = useRouter();
  const scroll = useRef<ScrollView>(null);
  const now = Date.now();

  /**
   * Which message the menu is open on. The owner: *"delete button is just one
   * click, what if i accidentally clicked it?"* — so nothing destructive is a
   * tap on the bubble; it is a choice in this sheet (NOTES §47).
   */
  const [acting, setActing] = useState<RoomMessage | null>(null);
  /** The message being edited, as a draft (NOTES §48). */
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  /** Somebody else's message being reported, or its sender being blocked (NOTES §51). */
  const [reporting, setReporting] = useState<RoomMessage | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; name: string } | null>(null);

  const byMessage = useMemo(() => {
    const map = new Map<string, Reaction[]>();
    for (const r of reactions) map.set(r.message_id, [...(map.get(r.message_id) ?? []), r]);
    return map;
  }, [reactions]);

  // Wrapped, never `mutationFn: actions.send`. TanStack Query calls a mutation
  // function with a SECOND argument of its own, and every send function in
  // src/data takes an optional database client there — passed by reference,
  // the room would send with TanStack's context object as its database, and
  // fail. Home carries the same warning for listSets; the community probe
  // caught this one in the moved Everyone room (NOTES §53).
  const send = useMutation({ mutationFn: (text: string) => actions.send(text), onSuccess: onChanged });
  const unsend = useMutation({
    mutationFn: ({ id, everyone }: { id: string; everyone: boolean }) =>
      everyone ? actions.unsendEveryone(id) : actions.hideForMe(id),
    onSuccess: async () => {
      setActing(null);
      await onChanged();
    },
  });
  const toggle = useMutation({
    mutationFn: ({ id, emoji, on }: { id: string; emoji: string; on: boolean }) => actions.react(id, emoji, on),
    onSuccess: async () => {
      setActing(null);
      await onChanged();
    },
  });
  const saveEdit = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => actions.edit(id, body),
    onSuccess: async () => {
      setEditing(null);
      await onChanged();
    },
  });

  const nameOf = (m: RoomMessage) => authorName(m.author_name);

  return (
    <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: space.lg }}>
      <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        <ScrollView
          ref={scroll}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingVertical: space.md, gap: space.md }}
          keyboardShouldPersistTaps="handled"
          // New messages arrive at the bottom, where a messenger keeps you —
          // the same behaviour as Nomi's chat, so the app has one idea of what
          // a conversation looks like.
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        >
          {loading ? (
            <LoadingState what="Loading messages…" />
          ) : messages.length === 0 ? (
            <StatePanel kind="empty" title={empty.title} detail={empty.detail} />
          ) : (
            messages.map((m, i) => (
              <Message
                key={m.id}
                name={nameOf(m)}
                avatar={m.author_avatar}
                userId={m.author_id}
                body={m.body}
                when={describeWhen(Date.parse(m.created_at), now)}
                mine={m.author_id === myId}
                showName={showNames}
                // Only the first of a run shows a face and a name. Five
                // messages in a row from one person with their picture beside
                // every one reads as five conversations, which is why every
                // messenger groups them.
                startsRun={messages[i - 1]?.author_id !== m.author_id}
                endsRun={messages[i + 1]?.author_id !== m.author_id}
                edited={!!m.edited_at}
                seen={m.id === seenId}
                canEdit={canEdit(m, myId, now)}
                tallies={tallyReactions(byMessage.get(m.id) ?? [], myId)}
                onAct={() => setActing(m)}
                onOpenPerson={() => router.push(`/person/${m.author_id}`)}
                onToggleReaction={(emoji, on) => toggle.mutate({ id: m.id, emoji, on })}
              />
            ))
          )}
        </ScrollView>

        {/* Everything you can do to a message, from a long press on a phone or
            the ⋯ on a laptop (NOTES §48). */}
        {acting ? (
          <MessageSheet
            mine={acting.author_id === myId}
            canEdit={canEdit(acting, myId, Date.now())}
            editWindowMinutes={EDIT_WINDOW_MINUTES}
            busy={unsend.isPending || toggle.isPending}
            error={
              unsend.isError
                ? (unsend.error as Error).message
                : toggle.isError
                  ? (toggle.error as Error).message
                  : null
            }
            onReact={(emoji) => {
              const already = (byMessage.get(acting.id) ?? []).some((r) => r.user_id === myId && r.emoji === emoji);
              toggle.mutate({ id: acting.id, emoji, on: !already });
            }}
            onEdit={() => {
              setEditing({ id: acting.id, body: acting.body });
              setActing(null);
            }}
            onUnsendEveryone={() => unsend.mutate({ id: acting.id, everyone: true })}
            onUnsendMe={() => unsend.mutate({ id: acting.id, everyone: false })}
            hideDetail={hideDetail}
            name={nameOf(acting)}
            onViewProfile={() => {
              setActing(null);
              router.push(`/person/${acting.author_id}`);
            }}
            onReport={() => {
              setReporting(acting);
              setActing(null);
            }}
            onBlock={() => {
              setBlocking({ id: acting.author_id, name: nameOf(acting) });
              setActing(null);
            }}
            onClose={() => setActing(null)}
          />
        ) : null}

        {reporting ? (
          <ReportSheet
            kind={reportKind}
            targetId={reporting.id}
            name={nameOf(reporting)}
            onBlock={() => {
              setBlocking({ id: reporting.author_id, name: nameOf(reporting) });
              setReporting(null);
            }}
            onClose={() => setReporting(null)}
          />
        ) : null}
        {blocking ? (
          <BlockSheet
            personId={blocking.id}
            name={blocking.name}
            onBlocked={() => void onChanged()}
            onClose={() => setBlocking(null)}
          />
        ) : null}

        {/* Editing happens in the message list rather than in the sheet: you
            need to see the conversation around what you are rewording. */}
        {editing ? (
          <View style={{ paddingBottom: space.sm }}>
            <Card>
              <Label>Edit your message</Label>
              <Field
                label="Message"
                value={editing.body}
                onChangeText={(body) => setEditing((e) => (e ? { ...e, body } : e))}
                autoCapitalize="sentences"
                maxLength={MESSAGE_MAX_LENGTH}
              />
              {saveEdit.isError ? <Notice tone="error">{(saveEdit.error as Error).message}</Notice> : null}
              <Button label="Save" onPress={() => saveEdit.mutate(editing)} busy={saveEdit.isPending} />
              <Button label="Cancel" variant="secondary" onPress={() => setEditing(null)} disabled={saveEdit.isPending} />
              <Body muted>{editNote}</Body>
            </Card>
          </View>
        ) : null}

        {send.isError ? (
          <View style={{ paddingBottom: space.sm }}>
            <Notice tone="error">{(send.error as Error).message}</Notice>
          </View>
        ) : null}

        <View style={{ paddingBottom: space.lg, backgroundColor: t.bg }}>
          {closed ? (
            <Notice tone="info">{closed}</Notice>
          ) : (
            <Composer
              onSend={(text) => send.mutate(text)}
              busy={send.isPending}
              placeholder={placeholder}
              // The database refuses anything longer, so the box stops there
              // rather than letting someone type a page and then be told no.
              maxLength={MESSAGE_MAX_LENGTH}
              emoji
            />
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * One message, the way a messenger draws one (NOTES §47).
 *
 * The owner: *"make the ui very similar to 'Messenger' app for cleaner look
 * (like my chats is placed on the right side, other is on left.) add bubbles to
 * the chat so it doesn't look plain (it just blends in the background)."*
 *
 * So: yours right and tinted, theirs left on the card surface, both in bubbles
 * that separate the words from the page. It was plain text on the background,
 * which is exactly the "blends in" he describes — there was nothing to say
 * where one message ended and the next began except a gap.
 *
 * ## The corner that is not round
 *
 * Each bubble has three round corners and one squarer one, on the side it came
 * from. It is what makes a stack of bubbles read as a direction rather than as
 * a column of lozenges, and it costs one line.
 *
 * ## Tap the bubble, not a Delete link
 *
 * A visible "Delete" beside every message is a one-tap mistake waiting to
 * happen — which is the report this was written from. The bubble itself opens
 * the unsend choice, so nothing destructive is ever one tap away, and the
 * choice does the confirming.
 */
function Message({
  name,
  avatar,
  userId,
  body,
  when,
  mine,
  showName,
  startsRun,
  endsRun,
  edited,
  seen,
  canEdit: editable,
  tallies,
  onAct,
  onOpenPerson,
  onToggleReaction,
}: {
  name: string;
  avatar: string | null;
  userId: string;
  body: string;
  when: string;
  mine: boolean;
  showName: boolean;
  startsRun: boolean;
  endsRun: boolean;
  edited: boolean;
  /** "Seen" under this one — the last of mine they have read (NOTES §53). */
  seen: boolean;
  canEdit: boolean;
  tallies: ReactionTally[];
  onAct: () => void;
  /** Their page, from their name or their face (NOTES §51). */
  onOpenPerson: () => void;
  onToggleReaction: (emoji: string, on: boolean) => void;
}) {
  const t = useTheme();
  const AVATAR = 28;

  /**
   * Hover, on a pointer device only.
   *
   * `onPointerEnter` exists on react-native-web and is inert on a touch screen,
   * which is exactly right: a phone has no hover, and the long press below is
   * its way in. Kept on the whole row rather than on the buttons, or the
   * controls would vanish as the mouse travelled towards them.
   */
  const [hovered, setHovered] = useState(false);
  const longPress = useLongPress(onAct);

  return (
    <View
      style={{
        alignItems: mine ? 'flex-end' : 'flex-start',
        // A run from one person sits close together; a change of speaker opens
        // a gap. That spacing is most of what makes a stack of bubbles legible.
        marginTop: startsRun ? space.sm : 2,
        gap: 2,
      }}
    >
      {/* Their name, once, above the first bubble of a run. Never on yours —
          "You" over every message you send is a label nobody needs — and not
          between two people, where it could only ever be the same name. */}
      {showName && startsRun && !mine ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${name}'s profile`}
          onPress={onOpenPerson}
          hitSlop={6}
          style={{ marginLeft: AVATAR + space.sm }}
        >
          <Text style={[type.caption, { color: t.textMuted, fontWeight: '700' }]}>{name}</Text>
        </Pressable>
      ) : null}

      {/* The bubble, the face and the hover controls on one row, bottom-aligned
          so the face sits beside the message rather than beside the time under
          it. The time is outside this row for exactly that reason. */}
      <View
        style={{
          flexDirection: mine ? 'row-reverse' : 'row',
          gap: space.sm,
          alignItems: 'flex-end',
          maxWidth: '92%',
        }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        {/* The face goes on the LAST bubble of a run, where a messenger puts
            it, with a spacer holding the line on the others. */}
        {!mine ? (
          endsRun ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`${name}'s profile`} onPress={onOpenPerson}>
              <PersonAvatar avatar={avatar} userId={userId} name={name} size={AVATAR} />
            </Pressable>
          ) : (
            <View style={{ width: AVATAR }} />
          )
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${mine ? 'You' : name} said ${body}. ${when}${
            edited ? ', edited' : ''
          }. Hold for reactions and more.`}
          // A long press on a touch screen; the ⋯ beside it on a pointer. The
          // bubble is no longer a one-tap unsend — the owner unsent something by
          // accident that way (NOTES §47), and this is the fix he asked for.
          onLongPress={onAct}
          delayLongPress={450}
          {...longPress}
          style={({ pressed }) => ({
            flexShrink: 1,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderRadius: radius.lg,
            // The squarer corner points at whoever said it, on the last bubble
            // of their run — which is what makes a stack read as a direction
            // rather than as a column of lozenges.
            borderBottomRightRadius: mine && endsRun ? radius.sm : radius.lg,
            borderBottomLeftRadius: !mine && endsRun ? radius.sm : radius.lg,
            backgroundColor: mine ? t.accent : t.card,
            borderWidth: mine ? 0 : 1,
            borderColor: t.border,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Text style={[type.body, { color: mine ? t.accentText : t.text }]} selectable>
            {body}
          </Text>
        </Pressable>

        <HoverActions visible={hovered} mine={mine} canEdit={editable} onPick={onAct} />
      </View>

      <ReactionChips tallies={tallies} alignEnd={mine} onToggle={onToggleReaction} />

      {/* Once per run, not once per message. Six timestamps down a page of one
          person talking is six times as much furniture as the information in
          it deserves. "edited" rides along with it, which is what keeps editing
          honest — 0021 refused silent edits, and this is the mark that makes
          them not silent (NOTES §48). "Seen" rides along too, on one message. */}
      {endsRun || seen ? (
        <Text style={[type.caption, { color: t.textMuted, marginLeft: mine ? 0 : AVATAR + space.sm }]}>
          {endsRun ? when : ''}
          {endsRun && edited ? ' · edited' : ''}
          {seen ? `${endsRun ? ' · ' : ''}Seen` : ''}
        </Text>
      ) : null}
    </View>
  );
}
