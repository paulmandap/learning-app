import { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, Label, LoadingState, Notice, Title } from '../../src/ui/components';
import { StatePanel } from '../../src/ui/states';
import { Segment } from '../../src/ui/segment';
import { Composer } from '../../src/ui/nomi';
import { PersonAvatar } from '../../src/ui/avatar';
import { CONTENT_MAX_WIDTH, radius, space, TOUCH_TARGET, type, useTheme } from '../../src/ui/theme';
import {
  authorName,
  browseOrder,
  MESSAGE_MAX_LENGTH,
  rankSets,
  starLabel,
  canStar,
  type ChatMessage,
  type PublicSet,
} from '../../src/core/community';
import { describeWhen } from '../../src/core/chat';
import {
  CommunityUnavailableError,
  deleteMessageForEveryone,
  hideMessage,
  listMessages,
  listPublicSets,
  myStars,
  sendMessage,
  star,
  unstar,
} from '../../src/data/community';
import { useSessionStore } from '../../src/data/session';

/**
 * Community — sets people have shared, which of them are best, and one room to
 * talk in.
 *
 * ## What it is, and what it deliberately is not
 *
 * Three segments rather than three tabs. Six tabs at 393px is about 65 points
 * each, which is where the labels stop fitting and a bottom bar becomes the
 * icon-only guessing game `app/(tabs)/_layout.tsx` rejects on purpose. These
 * three belong together anyway — they are all "other people".
 *
 * There are no profiles to visit, no following, no replies and no direct
 * messages. Five people who already know each other do not need a social
 * network; they need to see what the others made, say which of it was good,
 * and talk. Every one of those absences is a thing that would need moderating.
 *
 * ## Nothing here is the study path
 *
 * Tapping a shared set opens the ordinary set screen, which reads it through
 * `readableSet` and knows it is not yours. Studying it is studying it — the
 * same decks, the same schedule, your own answers. This screen only finds it.
 */

type Pane = 'sets' | 'top' | 'chat';

const PANES = [
  { key: 'sets' as const, label: 'Sets' },
  { key: 'top' as const, label: 'Top sets' },
  { key: 'chat' as const, label: 'Chat' },
];

/**
 * How often the chat asks for new messages while you are looking at it.
 *
 * Polling, not Supabase's realtime channels. Realtime would be live rather than
 * four-seconds-late and costs no new dependency — it is already inside
 * supabase-js — but it is a second transport with its own connection states,
 * its own reconnection behaviour and its own failure that looks like silence,
 * for five people in one room. A query with an interval is the same TanStack
 * Query path as every other read in the app, and it stops when the screen is
 * not on top (`refetchIntervalInBackground` defaults to false), so a phone in a
 * pocket asks for nothing.
 *
 * Worth revisiting on evidence: if the room is ever busy enough that
 * four seconds reads as broken, that is the measurement that reopens it.
 */
const CHAT_POLL_MS = 4000;

export default function Community() {
  const t = useTheme();
  const [pane, setPane] = useState<Pane>('sets');

  return (
    // Not `Screen`: the chat needs a bounded scroll area with the box to type in
    // pinned under it, and `Screen` is one ScrollView around everything — the
    // composer would scroll away with the messages. TabSlot gives this flex:1,
    // which is what bounds the pane below (NOTES §33).
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.lg }}>
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: space.md }}>
          <Title>Community</Title>
          <Segment value={pane} options={PANES} onChange={setPane} />
        </View>
      </View>

      {pane === 'chat' ? <ChatPane /> : <SetsPane ranked={pane === 'top'} />}
    </View>
  );
}

// ------------------------------------------------------------ shared sets --

function SetsPane({ ranked }: { ranked: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const myId = useSessionStore((s) => s.session?.user.id ?? '');

  const { data: sets, isLoading, error } = useQuery({
    queryKey: ['public-sets'],
    queryFn: () => listPublicSets(),
    // A missing view is a migration that has not been applied, not a blip —
    // the same rule the notebook follows.
    retry: (count, err) => !(err instanceof CommunityUnavailableError) && count < 1,
  });

  const { data: starred } = useQuery({
    queryKey: ['my-stars'],
    queryFn: () => myStars(),
    retry: (count, err) => !(err instanceof CommunityUnavailableError) && count < 1,
  });

  const toggleStar = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => (on ? star(id) : unstar(id)),
    // Both lists change: the star on the row, and the order of the ranking.
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['my-stars'] });
      await queryClient.invalidateQueries({ queryKey: ['public-sets'] });
    },
  });

  // `rank` is present only in the ranking. Typed as optional here rather than
  // narrowed at the call site, because `'rank' in set` widens the value to
  // unknown and the row would then take a number it could not check.
  const shown: (PublicSet & { rank?: number })[] = useMemo(
    () => (ranked ? rankSets(sets ?? []) : browseOrder(sets ?? [])),
    [sets, ranked],
  );

  if (isLoading) return <Pane><LoadingState /></Pane>;
  if (error instanceof CommunityUnavailableError) return <Pane><NotSwitchedOn /></Pane>;
  if (error) {
    return (
      <Pane>
        <Notice tone="error">Couldn&apos;t load what people have shared. Try again in a moment.</Notice>
      </Pane>
    );
  }

  if (shown.length === 0) {
    return (
      <Pane>
        <StatePanel
          kind="empty"
          title={ranked ? 'No stars yet' : 'Nothing shared yet'}
          detail={
            ranked
              ? 'When someone stars a shared set, the best ones show up here.'
              : 'Open one of your sets and share it, and everyone will find it here.'
          }
        />
      </Pane>
    );
  }

  return (
    <Pane>
      {toggleStar.isError ? (
        <Notice tone="error">{(toggleStar.error as Error).message}</Notice>
      ) : null}

      {shown.map((set) => (
        <SharedSetRow
          key={set.id}
          set={set}
          rank={set.rank}
          starred={starred?.has(set.id) ?? false}
          mine={set.owner_id === myId}
          canStar={canStar(set, myId)}
          busy={toggleStar.isPending && toggleStar.variables?.id === set.id}
          onOpen={() => router.push(`/set/${set.id}`)}
          onToggleStar={(on) => toggleStar.mutate({ id: set.id, on })}
        />
      ))}
    </Pane>
  );
}

/**
 * One shared set.
 *
 * Not `ListRow`, which is a title, a line of meta and a chevron. This row has a
 * control in it — the star — and a control inside a row that is itself a button
 * needs the two touch targets kept apart, or starring something opens it
 * instead. Hence the star as its own Pressable beside the pressable row rather
 * than inside it.
 */
function SharedSetRow({
  set,
  rank,
  starred,
  mine,
  canStar: starrable,
  busy,
  onOpen,
  onToggleStar,
}: {
  set: PublicSet;
  rank?: number;
  starred: boolean;
  mine: boolean;
  canStar: boolean;
  busy: boolean;
  onOpen: () => void;
  onToggleStar: (on: boolean) => void;
}) {
  const t = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        padding: space.md,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.card,
      }}
    >
      {rank !== undefined ? (
        // The number, not a medal: three medals and then a run of grey numbers
        // says "you lost" to everyone below third, in a room of five people.
        <Text style={[type.bodyStrong, { color: t.textMuted, minWidth: 24 }]}>{rank}</Text>
      ) : null}

      <PersonAvatar
        avatar={set.owner_avatar}
        userId={set.owner_id}
        name={authorName(set.owner_name)}
        size={32}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${set.title}, by ${authorName(set.owner_name)}, ${starLabel(set.stars)}`}
        onPress={onOpen}
        style={({ pressed }) => ({ flex: 1, gap: 2, opacity: pressed ? 0.7 : 1 })}
      >
        <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={2}>
          {set.title}
        </Text>
        <Text style={[type.caption, { color: t.textMuted }]}>
          {mine ? 'Shared by you' : `by ${authorName(set.owner_name)}`} · {set.cards} card
          {set.cards === 1 ? '' : 's'}
        </Text>
      </Pressable>

      <StarButton
        count={set.stars}
        on={starred}
        disabled={!starrable || busy}
        // Your own set shows its count and cannot be tapped. Saying why in a
        // label rather than hiding the number: the owner still wants to see it.
        reason={mine ? 'Your own set' : undefined}
        onPress={() => onToggleStar(!starred)}
      />
    </View>
  );
}

function StarButton({
  count,
  on,
  disabled,
  reason,
  onPress,
}: {
  count: number;
  on: boolean;
  disabled: boolean;
  reason?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled }}
      accessibilityLabel={reason ?? `${on ? 'Remove your star' : 'Star this set'}, ${starLabel(count)}`}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => ({
        minWidth: TOUCH_TARGET,
        minHeight: TOUCH_TARGET,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        opacity: pressed ? 0.7 : disabled ? 0.55 : 1,
      })}
    >
      {/* Filled or hollow as well as coloured — never hue alone, the same rule
          the quiz options follow. */}
      <Text style={{ fontSize: 19, color: on ? t.accent : t.textMuted }}>{on ? '★' : '☆'}</Text>
      <Text style={[type.caption, { color: on ? t.accent : t.textMuted }]}>{count}</Text>
    </Pressable>
  );
}

// ------------------------------------------------------------------- chat --

function ChatPane() {
  const t = useTheme();
  const queryClient = useQueryClient();
  const myId = useSessionStore((s) => s.session?.user.id ?? '');
  const scroll = useRef<ScrollView>(null);
  const now = Date.now();

  const { data: messages = [], isLoading, error } = useQuery({
    queryKey: ['global-chat'],
    queryFn: () => listMessages(),
    refetchInterval: CHAT_POLL_MS,
    retry: (count, err) => !(err instanceof CommunityUnavailableError) && count < 1,
  });

  const send = useMutation({
    mutationFn: (text: string) => sendMessage(text),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['global-chat'] }),
  });

  /**
   * Which message is being unsent, if any.
   *
   * The owner: *"delete button is just one click, what if i accidentally
   * clicked it? already happened and i got sad there's no like confirmation."*
   * So Delete opens a choice instead of acting, and the choice IS the
   * confirmation — an "are you sure?" on a one-tap action would be one more tap
   * to learn to dismiss without reading.
   */
  const [unsending, setUnsending] = useState<ChatMessage | null>(null);

  const unsend = useMutation({
    mutationFn: ({ id, everyone }: { id: string; everyone: boolean }) =>
      everyone ? deleteMessageForEveryone(id) : hideMessage(id),
    onSuccess: async () => {
      setUnsending(null);
      await queryClient.invalidateQueries({ queryKey: ['global-chat'] });
    },
  });

  if (error instanceof CommunityUnavailableError) return <Pane><NotSwitchedOn /></Pane>;

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
          {isLoading ? (
            <LoadingState what="Loading messages…" />
          ) : messages.length === 0 ? (
            <StatePanel
              kind="empty"
              title="Nobody has said anything yet"
              detail="This is one room, and everyone signed in to Nomi is in it."
            />
          ) : (
            messages.map((m, i) => (
              <Message
                key={m.id}
                name={authorName(m.author_name)}
                avatar={m.author_avatar}
                userId={m.author_id}
                body={m.body}
                when={describeWhen(Date.parse(m.created_at), now)}
                mine={m.author_id === myId}
                // Only the first of a run shows a face and a name. Five
                // messages in a row from one person with their picture beside
                // every one reads as five conversations, which is why every
                // messenger groups them.
                startsRun={messages[i - 1]?.author_id !== m.author_id}
                endsRun={messages[i + 1]?.author_id !== m.author_id}
                onUnsend={() => setUnsending(m)}
              />
            ))
          )}
        </ScrollView>

        {unsending ? (
          <UnsendChoice
            mine={unsending.author_id === myId}
            busy={unsend.isPending}
            error={unsend.isError ? (unsend.error as Error).message : null}
            onPick={(everyone) => unsend.mutate({ id: unsending.id, everyone })}
            onCancel={() => setUnsending(null)}
          />
        ) : null}

        {send.isError ? (
          <View style={{ paddingBottom: space.sm }}>
            <Notice tone="error">{(send.error as Error).message}</Notice>
          </View>
        ) : null}

        <View style={{ paddingBottom: space.lg, backgroundColor: t.bg }}>
          <Composer
            onSend={(text) => send.mutate(text)}
            busy={send.isPending}
            placeholder="Say something"
            // The database refuses anything longer, so the box stops there
            // rather than letting someone type a page and then be told no.
            maxLength={MESSAGE_MAX_LENGTH}
            emoji
          />
        </View>
      </View>
    </View>
  );
}

/**
 * Unsending, as a choice rather than a confirmation.
 *
 * Two different things, named as two different things:
 *
 *  - **for you** takes it off your own screen and nobody else's, and works on
 *    anybody's message — you can clear something somebody else said without
 *    asking them to take it back;
 *  - **for everyone** removes it from the room, and is only ever offered on
 *    your own, because that is all the database will allow (0021).
 *
 * On somebody else's message there is only one thing to do, so it says so
 * plainly instead of showing a disabled second button nobody can use.
 */
function UnsendChoice({
  mine,
  busy,
  error,
  onPick,
  onCancel,
}: {
  mine: boolean;
  busy: boolean;
  error: string | null;
  onPick: (everyone: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <View style={{ paddingBottom: space.sm }}>
      <Card>
        <Label>Unsend this message</Label>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {mine ? (
          <>
            <Button label="Unsend for everyone" onPress={() => onPick(true)} busy={busy} />
            <Body muted>It disappears from the room. People who already read it will have read it.</Body>
            <Button label="Unsend for me only" variant="secondary" onPress={() => onPick(false)} disabled={busy} />
            <Body muted>It stays for everyone else, and goes from your screen.</Body>
          </>
        ) : (
          <>
            <Button label="Hide this from my screen" onPress={() => onPick(false)} busy={busy} />
            <Body muted>
              It stays in the room for everyone else — only the person who sent it can take it back.
            </Body>
          </>
        )}
        <Button label="Keep it" variant="secondary" onPress={onCancel} disabled={busy} />
      </Card>
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
  startsRun,
  endsRun,
  onUnsend,
}: {
  name: string;
  avatar: string | null;
  userId: string;
  body: string;
  when: string;
  mine: boolean;
  startsRun: boolean;
  endsRun: boolean;
  onUnsend: () => void;
}) {
  const t = useTheme();
  const AVATAR = 28;

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
          "You" over every message you send is a label nobody needs. */}
      {startsRun && !mine ? (
        <Text style={[type.caption, { color: t.textMuted, fontWeight: '700', marginLeft: AVATAR + space.sm }]}>
          {name}
        </Text>
      ) : null}

      {/* The bubble and the face on one row, bottom-aligned, so the face sits
          beside the message rather than beside the time under it. The time is
          outside this row for exactly that reason. */}
      <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-end', maxWidth: '86%' }}>
        {/* The face goes on the LAST bubble of a run, where a messenger puts
            it, with a spacer holding the line on the others. */}
        {!mine ? (
          endsRun ? (
            <PersonAvatar avatar={avatar} userId={userId} name={name} size={AVATAR} />
          ) : (
            <View style={{ width: AVATAR }} />
          )
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${mine ? 'You' : name} said ${body}. ${when}. Tap to unsend.`}
          onPress={onUnsend}
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
      </View>

      {/* Once per run, not once per message. Six timestamps down a page of one
          person talking is six times as much furniture as the information in
          it deserves. */}
      {endsRun ? (
        <Text style={[type.caption, { color: t.textMuted, marginLeft: mine ? 0 : AVATAR + space.sm }]}>
          {when}
        </Text>
      ) : null}
    </View>
  );
}

// ----------------------------------------------------------------- shared --

/** The scrolling column the two set panes live in. */
function Pane({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ alignItems: 'center', padding: space.lg }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: space.md }}>{children}</View>
    </ScrollView>
  );
}

/**
 * Migration 0021 has not been applied.
 *
 * Says what is true — nothing is missing from the account — rather than showing
 * an empty list, which would read as "nobody has shared anything" and send
 * somebody looking for a bug that is not there. Same words as the notebook's.
 */
function NotSwitchedOn() {
  return (
    <Card>
      <Body>Sharing isn&apos;t switched on yet.</Body>
      <Body muted>
        Nothing is missing from your account — this part of the app just needs to be set up.
        Everything else works as normal.
      </Body>
    </Card>
  );
}
