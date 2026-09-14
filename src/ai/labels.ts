/**
 * Asking where a picture's labels are (NOTES §44).
 *
 * Measured with `scripts/label-cover-probe.ts` before anything was built on it:
 * this prompt, in Gemini's own `box_2d` format, on `LABEL_MODEL`, placed 37 of 37
 * labels so a cover hid them completely. It asks for boxes around the TEXT of a
 * label — not around the part the label names, which is what NOTES §8.2 asked
 * for and could not get.
 */

export const LOCATE_LABELS_PROMPT = `Find the text labels in this picture.

For each label give its text exactly as written, and "box_2d": [ymin, xmin, ymax, xmax] around the TEXT of the label itself — not the shape or part it names — with coordinates normalised to 0-1000 relative to the whole image.

A label written over several lines is ONE label with one box. Include every label, however small.`;

export const LABELS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          box_2d: { type: 'array', items: { type: 'integer' } },
        },
        required: ['text', 'box_2d'],
      },
    },
  },
  required: ['labels'],
} as const;
