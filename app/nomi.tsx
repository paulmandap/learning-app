import { Body, Card, Screen } from '../src/ui/components';
import { NomiSlot } from '../src/ui/nomi';

/**
 * Nomi — the companion's own screen.
 *
 * ## What this is, and what it is not yet
 *
 * Nomi is the name of the help this app already has: the floating ✦ that
 * answers from the student's own notes. That button is Nomi in its in-context
 * form — it sees the card in front of you. This screen is the place Nomi will
 * live when the question is not about one card but about the studying itself:
 * *what should I do today, what am I weakest at, quiz me on what I keep
 * getting wrong.*
 *
 * None of that is built. This screen deliberately holds the space and says so.
 *
 * ## Why there is no conversation here yet
 *
 * Answering "what should I study today?" honestly needs the learning
 * intelligence of Phase C and the adaptive selection of Phase D. Wiring a chat
 * box to a model without them would produce confident, plausible, invented
 * advice about a student's progress — which is worse than an empty screen,
 * because it would be believed. The one thing a study companion must never do
 * is make up how you are doing.
 *
 * There is also a standing decision in the way. **D14 gives the assistant one
 * question and one answer with no history**, because a conversation re-sends
 * its whole thread on every turn and the allowance it spends is the same one
 * that makes the cards. A conversational Nomi reverses that, so it is a
 * decision to take deliberately, with its cost argued — not something to slip
 * in beneath a text input.
 *
 * ## No queries
 *
 * Opening this screen asks the database for nothing. `getNomiContext` in
 * `src/data/nomi.ts` is the boundary it will read through, and it stays unused
 * here until there is something true to show — a placeholder that quietly costs
 * a round trip on every visit is a placeholder that gets shipped and forgotten.
 */
export default function Nomi() {
  return (
    <Screen>
      {/* No body heading. The stack header already says "Nomi" beside the back
          chevron, and rendering it again as the first line of the body printed
          the word twice down the screen — caught by looking at it, not by any
          test. `note/[id]` does the same: the header names a pushed screen and
          the body gets on with it. (`new.tsx` keeps a body title because its
          wording changes with how you arrived; this one is always "Nomi".) */}
      <Card>
        <Body>Nomi will become your learning companion.</Body>
        <Body muted>
          Right now Nomi can answer questions about your notes — tap the ✦ button while you
          are studying and ask about the card in front of you. Soon Nomi will also know what
          you have been getting right and wrong, and be able to say what to study next.
        </Body>
      </Card>

      {/*
        The three boundaries this screen is holding open. They are named rather
        than merely left blank so the screen reads as unfinished on purpose,
        and so the next person can see where each piece is meant to attach.
      */}
      <Card>
        <NomiSlot heading="Conversation">
          Asking Nomi something here, rather than about a single card.
        </NomiSlot>
        <NomiSlot heading="What Nomi can do">
          Starting a review, building a set from what you keep missing, opening the right deck.
        </NomiSlot>
        <NomiSlot heading="What Nomi knows">
          What is due, which parts you find hard, and how this week has gone.
        </NomiSlot>
      </Card>
    </Screen>
  );
}
