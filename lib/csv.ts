/**
 * CSV parsing and writing, to RFC 4180.
 *
 * Hand-rolled rather than a dependency. The guardrails in `CLAUDE.md` say not
 * to add packages without flagging it, and SheetJS is listed for exports
 * only — so the choice was a new runtime dependency or eighty lines of state
 * machine. The state machine wins: what an operator uploads is a file
 * exported from Excel or Google Sheets, which means quoted fields, embedded
 * commas, embedded newlines and a UTF-8 BOM, and all four are handled here.
 *
 * Imports nothing, so the parser is reachable from a Client Component that
 * wants to preview a file before uploading it.
 */

export interface ParsedCsv {
  headers: string[];
  /** One entry per data row, keyed by header. */
  rows: Array<Record<string, string>>;
  /** 1-based line in the original file, for error messages. */
  lineNumbers: number[];
}

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

/**
 * Split CSV text into rows of raw cells.
 *
 * A character-at-a-time state machine because the alternative — splitting on
 * newlines then on commas — is wrong for any file containing an address with
 * a comma in it, which is most of them.
 */
export function parseCsvRows(text: string): string[][] {
  // Excel writes a BOM. Left in place it becomes part of the first header,
  // so "reference" silently stops matching.
  const input = text.replace(/^﻿/, '');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      sawAnyChar = true;
      continue;
    }

    if (char === '\r') {
      // CRLF or a lone CR; either way it ends the line.
      if (input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAnyChar = false;
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAnyChar = false;
      continue;
    }

    field += char;
    sawAnyChar = true;
  }

  if (inQuotes) {
    throw new CsvError(
      'The file ends inside a quoted value. A quote is probably unclosed.',
    );
  }

  // A trailing newline leaves an empty pending row, which is not a record.
  if (sawAnyChar || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Normalise a header so `Registration`, `registration` and `Reg. Number` all
 * land on the same key. Spreadsheets are edited by people.
 */
export function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Parse into header-keyed records.
 *
 * Rows that are entirely empty are dropped rather than reported: a file
 * exported from a spreadsheet routinely has a few, and calling them errors
 * would bury the ones that matter.
 */
export function parseCsv(text: string): ParsedCsv {
  const raw = parseCsvRows(text);
  if (raw.length === 0) throw new CsvError('That file is empty.');

  const headerRow = raw[0]!;
  const headers = headerRow.map(normaliseHeader);

  if (headers.every((header) => header === '')) {
    throw new CsvError('The first row must be the column headings.');
  }

  const duplicates = headers.filter(
    (header, index) => header !== '' && headers.indexOf(header) !== index,
  );
  if (duplicates.length > 0) {
    throw new CsvError(
      `The heading "${duplicates[0]}" appears more than once. Each column needs its own name.`,
    );
  }

  const rows: Array<Record<string, string>> = [];
  const lineNumbers: number[] = [];

  for (let index = 1; index < raw.length; index += 1) {
    const cells = raw[index]!;
    if (cells.every((cell) => cell.trim() === '')) continue;

    const record: Record<string, string> = {};
    headers.forEach((header, column) => {
      if (header === '') return;
      record[header] = (cells[column] ?? '').trim();
    });

    rows.push(record);
    // +1 for the header row, +1 because humans count from one. Embedded
    // newlines make this approximate; it is still the right neighbourhood,
    // and the row number in the report is what people actually navigate by.
    lineNumbers.push(index + 1);
  }

  return { headers: headers.filter((h) => h !== ''), rows, lineNumbers };
}

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * `=` and `+` are the obvious two. `-` because `-1+1` parses as an
 * expression. `@` because Excel accepts it as a legacy function prefix. Tab
 * and carriage return because Excel strips leading whitespace before deciding,
 * so ` =cmd` is still a formula.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Quote a cell only when it needs it, so a plain file stays readable.
 *
 * And defuse anything a spreadsheet would run.
 *
 * A CSV is not just data — Excel, LibreOffice and Sheets evaluate a cell
 * beginning `=`, `+`, `-` or `@` as a formula the moment the file is opened.
 * Since values here are typed by people (a client name, a job note, an
 * import error quoting the row that caused it), a name like
 * `=HYPERLINK("http://…","Click")` becomes a live link in the operator's
 * spreadsheet, and the DDE variants go further than that.
 *
 * The defusing is a leading apostrophe, which every spreadsheet reads as
 * "treat what follows as text" and does not display. Not stripping the
 * character: a genuine negative number or an address beginning with a dash is
 * data somebody needs to see, and quietly editing it would be its own bug.
 */
export function toCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';

  // Numbers come from the application, not from a text field, and prefixing
  // them would turn every amount into a string in the operator's spreadsheet.
  if (typeof value === 'number') return String(value);

  const text = FORMULA_LEAD.test(value) ? `'${value}` : value;

  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Build a CSV document from a header list and rows of plain objects. */
export function toCsv(
  headers: string[],
  rows: Array<Record<string, string | number | null | undefined>>,
): string {
  const lines = [headers.map(toCsvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => toCsvCell(row[header])).join(','));
  }
  // CRLF, because that is what Excel expects and it costs nothing.
  return `${lines.join('\r\n')}\r\n`;
}
