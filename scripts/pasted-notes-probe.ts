/**
 * Can Gemini tell notes from a message? (NOTES §45)
 *
 *   npx tsx --env-file=.env scripts/pasted-notes-probe.ts [--runs 3]
 *
 * Since §45 a message that asks for nothing and fits a chat message is offered
 * as a set only when Gemini says it is study material (`pasted_notes`). This
 * sends each case as the first message of a conversation, with Nomi's real
 * instruction, on GEMINI_API_KEY from .env, and prints what came back — beside
 * what Nomi's own patterns do with it, which must be nothing for every case.
 */
import { GeminiBrowserProvider } from '../src/ai/gemini';
import { buildNomiSystemPrompt } from '../src/ai/prompts';
import { CallQueue } from '../src/core/queue';
import { EMPTY_SNAPSHOT, modelBrief } from '../src/core/nomi-brain';
import { proposeAction, proposeNotesSet } from '../src/core/nomi-actions';
import { wordCount } from '../src/core/text';

const CASES: { name: string; notes: boolean; text: string }[] = [
  {
    name: "the owner's own message (NOTES §45), curly apostrophes",
    notes: false,
    text: "hey i did got up and it’s been 2 hrs. i took a bath, ate breakfast, started doing my pre-interview task. but i feel so much heavy in my chest and i don’t know why. i keep checking my phone and i can’t focus on anything for more than a few minutes. i still have so many things to finish today and it feels like i’m already behind before the day even started.",
  },
  {
    name: 'about their day, English',
    notes: false,
    text: "hi nomi, so today was really tiring. our teacher in computer programming gave us a surprise quiz and i think i did badly because i didn't review last night. i'm kinda stressed because midterms are next week and i still have so many topics to cover, like loops, arrays and functions. can you give me some tips on how to manage my time so i can study everything before the exam?",
  },
  {
    name: 'about their day, Taglish, no question mark',
    notes: false,
    text: "nomi kinakabahan ako for our midterms next week kasi i still haven't reviewed anything for programming and networking. my groupmates are also not helping with our project so i have to do most of it alone. i feel like i don't have enough time for everything and i just want to sleep all day honestly haha",
  },
  {
    name: 'a paragraph of notes with a question about it',
    notes: false,
    text: "i don't get this part of my notes: The Calvin cycle uses ATP and NADPH from the light-dependent reactions to fix carbon dioxide into a three-carbon sugar called G3P. The enzyme RuBisCO attaches carbon dioxide to RuBP, and most of the G3P is recycled to regenerate RuBP so the cycle can continue. why is most of it recycled?",
  },
  {
    name: 'lecture notes, one paragraph',
    notes: true,
    text: 'Photosynthesis happens in the chloroplasts of plant cells. The light-dependent reactions take place in the thylakoid membranes, where chlorophyll absorbs light and water is split, releasing oxygen. The energy is stored as ATP and NADPH. The Calvin cycle takes place in the stroma, where the enzyme RuBisCO fixes carbon dioxide into a three-carbon sugar, G3P. Most of the G3P is used to regenerate RuBP so the cycle can continue.',
  },
  {
    name: 'notes as bullets',
    notes: true,
    text: [
      'Computer parts',
      '- CPU: the processor that carries out instructions from programs.',
      '- RAM: short-term memory that holds data the CPU is using right now; it is cleared when the power is off.',
      '- Storage (SSD or HDD): keeps files and programs when the computer is off.',
      '- Motherboard: the main circuit board that connects every part.',
      '- PSU: the power supply unit, which turns wall power into the voltages the parts need.',
      '- GPU: draws images, video and games on the screen.',
    ].join('\n'),
  },
  {
    name: 'notes in Taglish',
    notes: true,
    text: 'Ang photosynthesis ay ang proseso kung saan ang mga halaman ay gumagawa ng pagkain gamit ang sikat ng araw. Nangyayari ito sa chloroplast. Sa light-dependent reactions, ang tubig ay nahahati at naglalabas ng oxygen. Sa Calvin cycle, ang carbon dioxide ay ginagawang asukal gamit ang ATP at NADPH. Ang chlorophyll ay ang pigment na sumisipsip ng liwanag at nagbibigay ng berdeng kulay sa dahon.',
  },
  {
    name: 'song lines (the stand-in ballad)',
    notes: true,
    text: [
      'I drove up north with the windows down in late October',
      'You had a thermos full of cider and a map you never read',
      'The radio kept cutting out between the pines and the water',
      "And you sang the parts you didn't know in your own words instead",
      'We stopped at a gas station where the owner knew your grandpa',
      'He gave us two free peaches and a warning about the rain',
      'You laughed and said the sky was only practicing its thunder',
      "And I believed you like I'd believe you over and over again",
    ].join('\n'),
  },
];

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Set GEMINI_API_KEY (it is in .env).');
  const args = process.argv.slice(2);
  const runs = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 3;

  const provider = new GeminiBrowserProvider(key);
  const queue = new CallQueue();
  const system = buildNomiSystemPrompt({ brief: modelBrief(EMPTY_SNAPSHOT), context: { kind: 'none' } });
  let right = 0;
  let total = 0;

  for (const c of CASES) {
    const patterns = proposeAction(c.text, EMPTY_SNAPSHOT);
    const wouldOffer = proposeNotesSet(c.text, EMPTY_SNAPSHOT) !== null;
    const answers: string[] = [];
    for (let run = 0; run < runs; run++) {
      try {
        const reply = await queue.run(() => provider.chat({ system, turns: [{ role: 'user', text: c.text }] }));
        const said = reply?.pastedNotes === true;
        total++;
        if (said === c.notes) right++;
        answers.push(`${said === c.notes ? 'ok' : 'NO'} ${said}`);
      } catch (err) {
        answers.push(`error ${err instanceof Error ? err.message.slice(0, 60) : String(err)}`);
      }
    }
    console.log(
      `${c.name} (${wordCount(c.text)} words, ${c.text.length} chars; notes: ${c.notes})\n` +
        `  patterns: ${patterns?.action?.kind ?? 'nothing'} · an offer if Gemini says notes: ${wouldOffer}\n` +
        `  pasted_notes: ${answers.join(' | ')}`,
    );
  }
  console.log(`\n${right} of ${total} answers right`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
