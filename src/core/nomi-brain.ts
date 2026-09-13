/**
 * Nomi's own brain: what it knows about the student, and the questions it can
 * answer without asking anyone.
 *
 * Pure. No react-native, no clock of its own, no database, no model.
 *
 * ## The owner's question, and the honest answer to it
 *
 * *"Is it possible to train the brain for Nomi or like MCP? so that it's
 * faster, smarter, instantaneous? or maybe combined brain? like Gemini for
 * complex answers, and nomi's brain for the overall app."*
 *
 * Training a model is not something a free tier and a phone can do, and MCP is
 * a way of plugging tools into AI clients like Claude Desktop — there is no
 * server here for it to live on. But the combined brain is exactly right, and
 * this is its first half (NOTES §36):
 *
 *  - **Questions about the student's own app are answered here, instantly,**
 *    from numbers the app already has: the streak, what is due, what was
 *    missed, the sets, what to study next. No network, no quota, and no chance
 *    of a model rounding "3 days" into "about a week".
 *  - **Everything else goes to Gemini** — small talk, explanations, "quiz me on
 *    this" — with `modelBrief` attached, so even there Nomi knows who it is
 *    talking to.
 *
 * ## Matching is deliberately narrow
 *
 * A question that looks like one of these but is not ("what is due process?",
 * "why do lightning bolts streak?") must fall through to Gemini. A wrong
 * instant answer is worse than a slower right one, so every pattern needs
 * words that make it about THIS student — "my", "how many … due", "what
 * should I study" — and the tests hold a list of near-misses that must return
 * null.
 */

export interface BrainSet {
  id: string;
  title: string;
  cards: number;
  /** Cards due today. */
  due: number;
  /** Cards whose last answer was wrong or partly right. */
  missed: number;
  /** Cards answered right three times running. */
  known: number;
}

export interface AppSnapshot {
  /** First name, when they have given one. */
  name: string | null;
  streak: number;
  studiedToday: boolean;
  dueToday: number;
  toRetry: number;
  totalAnswers: number;
  sets: BrainSet[];
}

export const EMPTY_SNAPSHOT: AppSnapshot = {
  name: null,
  streak: 0,
  studiedToday: false,
  dueToday: 0,
  toRetry: 0,
  totalAnswers: 0,
  sets: [],
};

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Lower case, curly quotes straightened, punctuation that carries no meaning dropped. */
function normalise(message: string): string {
  return message
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "A (5), B (2) and C (1)" — at most three, biggest first. */
function topSets(sets: BrainSet[], count: (s: BrainSet) => number, noun: string): string {
  const ranked = sets.filter((s) => count(s) > 0).sort((a, b) => count(b) - count(a));
  const shown = ranked.slice(0, 3).map((s) => `${count(s)} ${noun} ${s.title}`);
  const rest = ranked.length - shown.length;
  if (shown.length === 0) return '';
  const list = shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
  return rest > 0 ? `${list}, plus ${plural(rest, 'more set')}` : list;
}

/** Where to start, and why — shared by "what should I study" and Home's line. */
export function suggestion(snapshot: AppSnapshot): { set: BrainSet; reason: string } | null {
  const byMissed = [...snapshot.sets].sort((a, b) => b.missed - a.missed)[0];
  if (byMissed && byMissed.missed > 0) {
    return { set: byMissed, reason: `it has ${plural(byMissed.missed, 'card')} you missed` };
  }
  const byDue = [...snapshot.sets].sort((a, b) => b.due - a.due)[0];
  if (byDue && byDue.due > 0) {
    return { set: byDue, reason: `${plural(byDue.due, 'card')} ${byDue.due === 1 ? 'is' : 'are'} due` };
  }
  const leastKnown = [...snapshot.sets]
    .filter((s) => s.cards > 0 && s.known < s.cards)
    .sort((a, b) => a.known / a.cards - b.known / b.cards)[0];
  if (leastKnown) {
    return { set: leastKnown, reason: `you know ${leastKnown.known} of its ${leastKnown.cards} cards so far` };
  }
  return null;
}

type Intent = { name: string; test: RegExp; answer: (s: AppSnapshot) => string };

const INTENTS: Intent[] = [
  {
    name: 'greeting',
    test: /^(hi|hello|hey|heya|hiya|yo|good (morning|afternoon|evening))( there)?( nomi)?( ?\?)?$/,
    answer: (s) => {
      const hello = `Hi${s.name ? ` ${s.name}` : ''}!`;
      if (s.toRetry > 0) return `${hello} You have ${plural(s.toRetry, 'card')} to retry. What can I help with?`;
      if (s.dueToday > 0) return `${hello} You have ${plural(s.dueToday, 'card')} due today. What can I help with?`;
      return `${hello} You're all caught up. What can I help with?`;
    },
  },
  {
    name: 'streak',
    test: /\b(my|current|study) streak\b|\b(what'?s|what is|how long is|how'?s|check) (my |the )?streak\b|^streak ?\??$|\bhow many days in a row\b/,
    answer: (s) => {
      if (s.streak === 0) return "You don't have a streak going yet. Answer a card today and it starts.";
      if (s.studiedToday) return `You're on a ${s.streak}-day streak, and today already counts.`;
      return `You're on a ${s.streak}-day streak. Study something today to keep it going.`;
    },
  },
  {
    name: 'due',
    test: /\b(cards? (are |is )?due|due (cards?|today|now|for review)|anything due|what'?s due|what is due ?\??$|how many (cards? )?(are |do i have )?due|do i have (anything |any cards? )?(due|to review)|to review today)\b/,
    answer: (s) => {
      if (s.dueToday === 0) return "Nothing is due right now. You're on top of it.";
      const where = topSets(s.sets, (x) => x.due, 'in');
      return `${plural(s.dueToday, 'card')} ${s.dueToday === 1 ? 'is' : 'are'} due today${where ? `: ${where}` : ''}.`;
    },
  },
  {
    name: 'missed',
    test: /\b(what|which|how many)( cards?)? (did i|have i) (miss|get wrong)|\b(my|the) (missed|wrong) (cards?|answers?)\b|\bto retry\b|\bretry pile\b|\bmy mistakes\b/,
    answer: (s) => {
      if (s.toRetry === 0) return 'No missed cards to retry. Nice.';
      const where = topSets(s.sets, (x) => x.missed, 'in');
      return `${plural(s.toRetry, 'card')} to retry${where ? `: ${where}` : ''}.`;
    },
  },
  {
    name: 'next',
    test: /\bwhat should i (study|do|review|learn|start with|work on)\b|\bwhere should i start\b|\bwhat('?s| is) next\b|\bwhat do i study\b/,
    answer: (s) => {
      if (s.sets.length === 0) return "You don't have any sets yet. Add some notes and I'll help you study them.";
      const pick = suggestion(s);
      if (!pick) return "You know everything in your sets right now. Add new notes, or keep reviewing when cards come due.";
      return `Start with ${pick.set.title}: ${pick.reason}.`;
    },
  },
  {
    name: 'sets',
    test: /\b(how many|what|which|list) (study )?(sets|decks)\b|\bmy (study )?(sets|decks)\b/,
    answer: (s) => {
      if (s.sets.length === 0) return "You don't have any sets yet. Add some notes and I'll make cards from them.";
      const listed = s.sets.slice(0, 5).map((x) => `${x.title} (${plural(x.cards, 'card')})`);
      const more = s.sets.length > 5 ? `, and ${s.sets.length - 5} more` : '';
      return `You have ${plural(s.sets.length, 'set')}: ${listed.join(', ')}${more}.`;
    },
  },
  {
    name: 'progress',
    test: /\b(my progress|how am i doing|how'?m i doing|how (well )?have i been doing|how is my studying)\b/,
    answer: (s) => {
      const cards = s.sets.reduce((n, x) => n + x.cards, 0);
      const known = s.sets.reduce((n, x) => n + x.known, 0);
      if (s.totalAnswers === 0) return "You haven't answered any cards yet, so there's nothing to judge. Start a set and I'll keep track.";
      const streak = s.streak > 0 ? ` You're on a ${s.streak}-day streak.` : '';
      return `You know ${known} of your ${plural(cards, 'card')} (right three times in a row).${streak}`;
    },
  },
  {
    name: 'name',
    test: /\bwhat'?s my name\b|\bwhat is my name\b|\bwho am i\b|\bdo you know my name\b/,
    answer: (s) =>
      s.name ? `You're ${s.name}.` : "I don't know your name yet. You can add it in Settings.",
  },
  {
    name: 'who',
    test: /^(who|what) are you ?\??$|\bwhat can you do\b/,
    answer: () =>
      "I'm Nomi, your study companion. I can tell you what's due, what you missed and how your streak is going, and help with anything you're studying.",
  },
  {
    name: 'thanks',
    test: /^(thanks|thank you|thx|ty)( so much| a lot)?( nomi)?$/,
    answer: () => "You're welcome!",
  },
];

/**
 * Answer from the app's own data, or return null to hand the message to Gemini.
 *
 * Only short messages are considered. "Hi" is a greeting; a paragraph that
 * happens to start with "hi" is a question with manners, and deserves a real
 * answer.
 */
export function answerLocally(message: string, snapshot: AppSnapshot): { intent: string; text: string } | null {
  const said = normalise(message);
  if (said.length === 0 || said.split(' ').length > 12) return null;
  for (const intent of INTENTS) {
    if (intent.test.test(said)) return { intent: intent.name, text: intent.answer(snapshot) };
  }
  return null;
}

/**
 * The one line Nomi says on Home, beside the owl.
 *
 * Always true and always short. The most useful thing first: cards you got
 * wrong, then cards due, then the streak — and when there is nothing to do,
 * an invitation rather than a manufactured observation.
 */
export function homeLine(snapshot: AppSnapshot): string {
  if (snapshot.sets.length === 0) return "Add some notes and I'll help you study them.";
  if (snapshot.toRetry > 0) {
    return `${plural(snapshot.toRetry, 'card')} to retry. Coming back to those is where it sticks.`;
  }
  if (snapshot.dueToday > 0) return `${plural(snapshot.dueToday, 'card')} due today. Want to start?`;
  if (snapshot.streak > 0 && !snapshot.studiedToday) {
    return `You're on a ${snapshot.streak}-day streak. One card today keeps it going.`;
  }
  if (snapshot.streak > 0) return `${snapshot.streak}-day streak, and today counts. Ask me anything.`;
  return "You're all caught up. Ask me anything.";
}

/** Longest set list sent to the model. Past this, a summary line. */
const BRIEF_MAX_SETS = 15;

/**
 * What Gemini is told about the student, as plain facts.
 *
 * Stated as data, labelled as accurate, so the model quotes the numbers rather
 * than estimating them. Set titles are the student's own words and are sent as
 * they are — the privacy paragraph in Settings says so, with the owner's
 * approval (NOTES §36).
 */
export function modelBrief(snapshot: AppSnapshot): string {
  const lines = [
    'FACTS ABOUT THE STUDENT, from the app, accurate right now:',
    `- Name: ${snapshot.name ?? 'not given'}`,
    `- Study streak: ${plural(snapshot.streak, 'day')} (studied today: ${snapshot.studiedToday ? 'yes' : 'not yet'})`,
    `- Cards due today: ${snapshot.dueToday}`,
    `- Cards to retry (last answer wrong): ${snapshot.toRetry}`,
    `- Answers given, ever: ${snapshot.totalAnswers}`,
  ];
  if (snapshot.sets.length === 0) {
    lines.push('- Study sets: none yet');
  } else {
    lines.push('- Study sets (title: cards, due today, to retry, known):');
    for (const s of snapshot.sets.slice(0, BRIEF_MAX_SETS)) {
      lines.push(`  - ${s.title}: ${s.cards}, ${s.due}, ${s.missed}, ${s.known}`);
    }
    if (snapshot.sets.length > BRIEF_MAX_SETS) {
      lines.push(`  - and ${snapshot.sets.length - BRIEF_MAX_SETS} more sets`);
    }
  }
  return lines.join('\n');
}
