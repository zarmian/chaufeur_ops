import { describe, expect, it } from 'vitest';
import {
  canHaveNameBoard,
  escapeHtml,
  nameBoardDocument,
  nameBoardPath,
  nameScale,
  normaliseName,
  widthUnits,
} from './name-board';

/**
 * The board a driver holds up at arrivals.
 *
 * Two things are worth pinning. The type has to fit — a name that runs off
 * the sheet is a board nobody can read, and it is only discovered in an
 * arrivals hall. And a passenger's name is text somebody typed into a form,
 * so it goes through an HTML escape before it goes into a document.
 */

describe('who gets a board', () => {
  it('is airport transfers with a passenger on them', () => {
    expect(
      canHaveNameBoard({ jobType: 'AIRPORT_TRANSFER', passengerName: 'Mr Ali' }),
    ).toBe(true);
  });

  it('is not other job types', () => {
    // The decision was airport transfers only. Meeting somebody at arrivals is
    // the case that needs a board held up.
    expect(
      canHaveNameBoard({ jobType: 'TRANSFER', passengerName: 'Mr Ali' }),
    ).toBe(false);
    expect(
      canHaveNameBoard({ jobType: 'AS_DIRECTED', passengerName: 'Mr Ali' }),
    ).toBe(false);
  });

  it('is not a job with nobody named on it', () => {
    // A board is the name. Without one there is nothing to print, and
    // offering the button anyway produces a blank sheet.
    expect(
      canHaveNameBoard({ jobType: 'AIRPORT_TRANSFER', passengerName: null }),
    ).toBe(false);
    expect(
      canHaveNameBoard({ jobType: 'AIRPORT_TRANSFER', passengerName: '   ' }),
    ).toBe(false);
  });
});

describe('tidying the name', () => {
  it('collapses the whitespace somebody typed', () => {
    expect(normaliseName('  Mr   Jamal   Abdullah ')).toBe('Mr Jamal Abdullah');
  });

  it('treats nothing as nothing', () => {
    expect(normaliseName(null)).toBe('');
    expect(normaliseName(undefined)).toBe('');
    expect(normaliseName('\n\t ')).toBe('');
  });
});

describe('fitting the name to the board', () => {
  it('sets a short name larger than a long one', () => {
    expect(nameScale('Li')).toBeGreaterThan(nameScale('Mr Jamal Abdullah'));
    expect(nameScale('Mr Jamal Abdullah')).toBeGreaterThan(
      nameScale('Mr Christopher Featherstonehaugh-Wellesley'),
    );
  });

  it('measures the longest word, not the whole string', () => {
    /*
     * The distinction that makes long names work. Words wrap onto their own
     * lines, so three short words are three comfortable lines — it is a
     * single unbreakable word that sets the limit. Measured by total length
     * alone, "Mr Jo Li Ng Ab" would be shrunk as hard as one long surname.
     */
    const manyShort = nameScale('Mr Jo Li Ng Ab');
    const oneLong = nameScale('Featherstonehaughx');
    expect(manyShort).toBeGreaterThan(oneLong);
  });

  it('never sets a name so large its longest word runs off the edge', () => {
    for (const name of [
      'Li',
      'Mr Ali',
      'Mr Jamal Abdullah',
      'Wolfeschlegelsteinhausenbergerdorff',
      'Mr Christopher Featherstonehaugh-Wellesley',
      '田中さん',
      '김민준',
      'Владимир Ильич',
    ]) {
      const longest = Math.max(...name.split(' ').map(widthUnits));
      expect(nameScale(name) * longest, name).toBeLessThanOrEqual(100);
    }
  });

  /*
   * The height constraint is not tested here, and deliberately.
   *
   * Whether a name runs off the bottom depends on where the browser chooses
   * to break the lines and on the font's real metrics — neither of which a
   * unit test can know, and a model of them is a model that will disagree
   * with the thing it claims to describe. `tests/e2e/name-board.spec.ts`
   * loads real boards and measures them instead.
   */

  it('sets a square-glyph name smaller than a Latin one of the same length', () => {
    // Four CJK characters occupy the width of about seven Latin letters.
    expect(nameScale('田中さん')).toBeLessThan(nameScale('Abcd'));
  });

  it('does not blow a two-letter name up into a logo', () => {
    expect(nameScale('Li')).toBeLessThanOrEqual(26);
  });

  it('keeps a very long name readable rather than microscopic', () => {
    expect(nameScale('Wolfeschlegelsteinhausenbergerdorff')).toBeGreaterThanOrEqual(4);
  });

  it('has nothing to set for an empty name', () => {
    expect(nameScale('')).toBe(0);
  });

  it('counts characters, not bytes', () => {
    // An accented or non-Latin name is the same number of glyphs on a board
    // however many bytes it takes to store. Measured with a spread rather
    // than `.length`, which counts surrogate pairs twice and would shrink an
    // emoji-bearing or CJK name for no reason.
    expect(nameScale('日本語の名前')).toBeGreaterThan(nameScale('A'.repeat(30)));
  });
});

describe('the document', () => {
  it('escapes a name that would otherwise close a tag', () => {
    // A passenger name is text somebody typed into a form.
    const html = nameBoardDocument(['<script>alert(1)</script>']);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('shows nothing but the name', () => {
    // The decision was a plain board: no logo, no flight number, no
    // reference. Some clients specifically do not want their guests met by a
    // board advertising a supplier.
    const html = nameBoardDocument(['Mr Jamal Abdullah']);
    expect(html).toContain('Mr Jamal Abdullah');
    expect(html).not.toMatch(/logo|flight|terminal|reference/i);
  });

  it('is light on dark for a screen and dark on light for paper', () => {
    // Not a preference: a phone at arrivals-hall brightness reads better
    // light-on-dark and costs less battery, and the same choice on paper is a
    // solid sheet of toner.
    expect(nameBoardDocument(['Mr Ali'], 'screen')).toContain(
      'background: #000000',
    );
    expect(nameBoardDocument(['Mr Ali'], 'print')).toContain(
      'background: #ffffff',
    );
  });

  it('puts each board on its own sheet', () => {
    const html = nameBoardDocument(['Mr Ali', 'Ms Chen', 'Dr Okafor']);
    expect(html.match(/class="board"/g)).toHaveLength(3);
    expect(html).toContain('break-after: page');
  });

  it('asks for landscape A4 with no margin', () => {
    // A name board is the name, edge to edge. A page margin would shrink it.
    expect(nameBoardDocument(['Mr Ali'], 'print')).toContain(
      '@page { size: A4 landscape; margin: 0; }',
    );
  });
});

describe('the link', () => {
  it('is the token and nothing else', () => {
    // The job id is deliberately not in the path: the token is the whole
    // credential, and a URL carrying both invites the assumption that one of
    // them is optional.
    expect(nameBoardPath('abc123')).toBe('/board/abc123');
  });
});
