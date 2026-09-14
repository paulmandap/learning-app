import { faceValue } from '../core/avatar';
import { doneLine, type NomiAction } from '../core/nomi-actions';
import { createNote, linkNoteToSet, saveNote } from './notes';
import { saveAvatar, saveDisplayName, savePetChoice } from './profile';
import { writeReviewer } from './reviewer';
import { updateSet } from './sets';
import { startSet } from './start-set';

/**
 * Carrying out what Nomi offered, once the student has tapped to confirm it
 * (NOTES §37).
 *
 * Every write here is one the app already makes from its own screens, through
 * the same function — Nomi can do nothing a student's own taps cannot. And none
 * of the destructive ones: nothing here deletes, signs out or touches the key,
 * and `tests/screens.test.ts` fails if this file so much as imports a function
 * that could. The list of what can be done is `NomiAction`; the switch below is
 * exhaustive over it, so a new kind cannot be added without deciding here what
 * it does.
 */

export interface Done {
  /** What Nomi says afterwards. */
  text: string;
  /** A set whose cards are now being made — the set screen makes them. */
  openSetId?: string;
  openNoteId?: string;
}

/** Making cards needs the student's own key, which Nomi never sees or sets. */
export class NeedsKeyError extends Error {
  constructor() {
    super('A Gemini key is needed to make cards.');
    this.name = 'NeedsKeyError';
  }
}

export async function carryOut(action: NomiAction, input: { apiKey: string }): Promise<Done> {
  switch (action.kind) {
    case 'make_set':
    case 'add_notes': {
      if (!input.apiKey) throw new NeedsKeyError();
      const adding = action.kind === 'add_notes';
      const { setId } = await startSet({
        setId: adding ? action.setId : undefined,
        title: adding ? action.setTitle : action.title,
        sources: [{ text: action.notes }],
        count: action.count,
        apiKey: input.apiKey,
      });
      return { text: doneLine(action), openSetId: setId };
    }
    case 'write_reviewer': {
      if (!input.apiKey) throw new NeedsKeyError();
      // Written before anything is saved: if Gemini cannot write it, there is
      // no empty note and no set with nothing to make cards from.
      const body = await writeReviewer({ topic: action.topic, count: action.count, apiKey: input.apiKey });
      // In Notes as well as in the set: these facts are Gemini's, not the
      // student's, and Notes is where they can read them and put them right.
      const note = await createNote();
      await saveNote({ id: note.id, title: action.title, body });
      const { setId } = await startSet({
        title: action.title,
        sources: [{ text: body }],
        count: action.count,
        apiKey: input.apiKey,
      });
      await linkNoteToSet(note.id, setId);
      return { text: doneLine(action), openSetId: setId, openNoteId: note.id };
    }
    case 'rename_set':
      await updateSet(action.setId, { title: action.to });
      return { text: doneLine(action) };
    case 'save_note': {
      const note = await createNote();
      await saveNote({ id: note.id, title: action.title, body: action.body });
      return { text: doneLine(action), openNoteId: note.id };
    }
    case 'set_name':
      await saveDisplayName(action.name);
      return { text: doneLine(action) };
    case 'set_pet':
      await savePetChoice(action.pet);
      return { text: doneLine(action) };
    case 'set_face':
      await saveAvatar(faceValue(action.index));
      return { text: doneLine(action) };
  }
}
