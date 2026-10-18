/**
 * Turning the bytes of a PDF into the page as text, laid out.
 *
 * A PDF has no lines and no columns. It has glyphs at coordinates, and the
 * reader in this directory depends entirely on layout — a run of three spaces
 * is what separates a destination address from the charges printed beside it,
 * and an indent is the only thing tying `5` to `# of Pax` rather than to
 * `Vehicle Type`. So this does not merely concatenate the text: it puts each
 * run back at the column it was printed in, which is what `pdftotext -layout`
 * does and what the fixtures were captured with.
 *
 * Text only. Nothing here renders, rasterises or executes anything from the
 * document: no canvas, no fonts fetched, no JavaScript — a PDF can carry all
 * three, and a job sheet arrives by email from whoever cares to send one.
 */

/** Said to the operator, so each refusal names something they can act on. */
export class PdfTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfTextError';
  }
}

/**
 * Nothing to read.
 *
 * Almost always a scan or a photograph: the page is one image and the glyphs
 * are pixels. Worth its own message, because "could not read the date" sends
 * somebody hunting for a bug in the reader when the answer is that the file
 * contains no text at all and never will without OCR.
 */
export const NO_TEXT =
  'There is no text in this PDF — it looks like a scan or a photograph. ' +
  'Ask the sender for the original, or enter the job by hand.';

interface Run {
  text: string;
  x: number;
  y: number;
  width: number;
}

/**
 * How far apart two runs' baselines may be and still be the same line.
 *
 * Generous, because a line that mixes font sizes — a heading beside a value —
 * has baselines a point or two apart and splitting it would put a label and its
 * value on separate lines, which is exactly what the reader cannot cope with.
 */
const LINE_TOLERANCE = 3;

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  /*
   * Imported here rather than at the top of the file so that the library is
   * loaded only when a sheet is actually uploaded. It is large, and every
   * other route in the application would otherwise pay for it.
   *
   * The legacy build is the one that runs under Node without a DOM.
   */
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  let document;
  try {
    document = await pdfjs.getDocument({
      data: bytes,
      // A job sheet needs none of these, and each is a way for a document to
      // reach outside itself or to run.
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'unknown';
    throw new PdfTextError(`This file could not be opened as a PDF (${reason}).`);
  }

  try {
    const pages: string[] = [];

    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();

      const runs: Run[] = [];
      for (const item of content.items) {
        if (!('str' in item) || item.str === '') continue;

        runs.push({
          text: item.str,
          // transform is [a, b, c, d, e, f]; e and f are the position.
          x: item.transform[4] ?? 0,
          y: item.transform[5] ?? 0,
          width: item.width ?? 0,
        });
      }

      pages.push(layOut(runs));
      page.cleanup();
    }

    const text = pages.join('\n\n').trimEnd();
    if (text.trim() === '') throw new PdfTextError(NO_TEXT);

    return text;
  } finally {
    await document.destroy();
  }
}

/**
 * Put the runs back on lines, at the columns they were printed in.
 *
 * The scale is taken from the document itself — the median width of a character
 * across the page — rather than assumed. Agency sheets are set in anything from
 * 7pt to 11pt, and a fixed guess either crushes the columns together or spreads
 * a line to several hundred characters, and the reader's "three spaces is a
 * column break" rule fails in both directions.
 */
export function layOut(runs: Run[]): string {
  if (runs.length === 0) return '';

  const charWidth = medianCharWidth(runs);

  // Grouped by baseline, descending: a PDF's y grows upwards, a page reads
  // downwards.
  const lines: Run[][] = [];
  for (const run of [...runs].sort((left, right) => right.y - left.y)) {
    const last = lines.at(-1);
    if (last && Math.abs((last[0]?.y ?? 0) - run.y) <= LINE_TOLERANCE) {
      last.push(run);
    } else {
      lines.push([run]);
    }
  }

  const left = Math.min(...runs.map((run) => run.x));

  return lines
    .map((line) => {
      let out = '';

      for (const run of line.sort((one, two) => one.x - two.x)) {
        const column = Math.round((run.x - left) / charWidth);
        // Never pull a run backwards into the one before it: two runs can
        // overlap by a fraction of a character, and the text matters more than
        // the column.
        if (column > out.length) out = out.padEnd(column, ' ');
        out += run.text;
      }

      return out.replace(/\s+$/, '');
    })
    .join('\n');
}

/**
 * The width of one character, in the units the positions are given in.
 *
 * The median over runs long enough to be meaningful, so that one wide heading
 * or a line of dots cannot set the scale for the page.
 */
function medianCharWidth(runs: Run[]): number {
  const widths = runs
    .filter((run) => run.width > 0 && run.text.trim().length >= 3)
    .map((run) => run.width / run.text.length)
    .sort((left, right) => left - right);

  if (widths.length === 0) return 5;

  return widths[Math.floor(widths.length / 2)] ?? 5;
}
