import { describe, expect, it } from 'vitest';
import { layOut } from './pdf';

/**
 * Putting a PDF's glyphs back into columns.
 *
 * A PDF has no lines and no columns — it has runs of text at coordinates — and
 * everything in this directory depends on layout. A run of three spaces is what
 * separates a destination address from the charges printed beside it, and an
 * indent is the only thing tying `5` to `# of Pax` rather than to the column
 * after it. If this step flattens the page, nothing downstream can recover.
 */

const run = (text: string, x: number, y: number, width = text.length * 5) => ({
  text,
  x,
  y,
  width,
});

describe('layOut', () => {
  it('puts runs on one line when they share a baseline', () => {
    const text = layOut([
      run('Pick-up Date:', 0, 700),
      run('14 Oct 2026', 300, 700),
    ]);

    expect(text.split('\n')).toHaveLength(1);
    expect(text).toMatch(/^Pick-up Date: {3,}14 Oct 2026$/);
  });

  it('reads down the page, not up it', () => {
    // A PDF's y grows upwards and a page reads downwards. Getting this
    // backwards puts the standing instructions above the booking and the
    // reader's "stop at the next label" rules run the wrong way.
    const text = layOut([
      run('second', 0, 600),
      run('first', 0, 700),
      run('third', 0, 500),
    ]);

    expect(text.split('\n')).toEqual(['first', 'second', 'third']);
  });

  it('keeps a label and its value on one line through a size change', () => {
    /*
     * A heading set larger than the value beside it has a baseline a point or
     * two off. Splitting there would put every label on its own line and
     * detach it from what it labels.
     */
    const text = layOut([run('Pick-up Time:', 0, 700), run('03:00 PM', 300, 698)]);

    expect(text.split('\n')).toHaveLength(1);
  });

  it('separates columns far enough apart for a column break to be visible', () => {
    /*
     * The bug this whole file exists to avoid. The second line of the
     * destination shares its row with the first charge line, and the reader
     * tells them apart only by the gap between them.
     */
    const text = layOut([
      run('London, SW7 2AP', 0, 600),
      run('Service Charge', 400, 600),
    ]);

    expect(text).toMatch(/London, SW7 2AP {3,}Service Charge/);
  });

  it('scales to the size the sheet is set in', () => {
    /*
     * Agency sheets are set in anything from 7pt to 11pt. The column positions
     * are taken from the document's own character width rather than a fixed
     * guess, which either crushes the columns together or spreads one line
     * across several hundred characters — and the three-space rule fails in
     * both directions.
     */
    const small = layOut([
      run('Label:', 0, 700, 18),
      run('Value', 60, 700, 15),
    ]);
    const large = layOut([
      run('Label:', 0, 700, 72),
      run('Value', 240, 700, 60),
    ]);

    // Same proportions, so the same number of spaces between them.
    expect(small).toBe(large);
  });

  it('indents from the leftmost run on the page', () => {
    // A sheet with a margin should not come out indented by its margin: the
    // indent that matters is relative to the page's own left edge.
    const text = layOut([run('First', 100, 700), run('Second', 100, 690)]);

    expect(text).toBe('First\nSecond');
  });

  it('never loses text to an overlapping run', () => {
    /*
     * Two runs can overlap by a fraction of a character — kerning, or a
     * ligature split across items. The text matters more than the column, so
     * the run is appended rather than being dropped or pulled backwards.
     */
    const text = layOut([run('Heathrow', 0, 700, 40), run('Terminal 5', 38, 700, 50)]);

    expect(text).toContain('Heathrow');
    expect(text).toContain('Terminal 5');
  });

  it('has nothing to lay out for an empty page', () => {
    expect(layOut([])).toBe('');
  });
});
