import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJobSheet } from './index';
import { montclares, parseSheetDate, parseSheetMoney, parseSheetTime } from './montclares';
import { firstCell, toLines } from './types';

/**
 * Reading a real agency job sheet.
 *
 * The fixture is the text of an actual Montclares booking, extracted from the
 * PDF they sent — so these are not assertions about a layout somebody imagined.
 * The three failures worth testing for are all the same kind of failure: a
 * field that comes back confidently wrong.
 *
 * A wrong date puts a car out on the wrong day. A wrong address sends it to the
 * wrong building. And an invented price turns a job that should be shouting
 * "unpriced" into one that reconciles to nothing.
 */

const SHEET = readFileSync(
  join(__dirname, '__fixtures__', 'montclares-30700.txt'),
  'utf8',
);

describe('the Montclares sheet', () => {
  const read = readJobSheet(SHEET);

  it('is recognised', () => {
    expect(read.template?.name).toBe('montclares');
  });

  it('reads every field a booking needs', () => {
    expect(read.missing).toEqual([]);
    expect(read.draft).toMatchObject({
      scheduledDate: '2026-10-14',
      // 03:00 PM, in the form's own 24-hour field.
      scheduledTime: '15:00',
      passengerName: 'Shawna Rayford',
      passengerPhone: '+1 615-635-7516',
      passengerCount: '5',
      theirReference: '30700',
      vehicleRequested: 'V Class',
    });
  });

  it('reads both addresses whole, including the postcode on the wrapped line', () => {
    // The address runs onto a second line and the postcode is on it. An
    // address stopping at "60 Upper Thames Street," is one a driver cannot
    // navigate to and an operator has to retype — which is the whole point.
    expect(read.draft.pickupText).toBe(
      'The Westin London City, 60 Upper Thames Street, London, EC4V 3AD',
    );
    expect(read.draft.dropoffText).toBe(
      'Royal Albert hall Kensington Gore, South Kensington London, SW7 2AP',
    );
  });

  it('does not drag the charges column into the destination', () => {
    /*
     * The bug this found. The sheet is two columns wide and the extractor sees
     * one line per row, so the second line of the destination shares its row
     * with the first charge line — and a naive read produced
     * "…SW7 2AP Service Charge Parking Tolls VAT".
     */
    for (const word of ['Service Charge', 'Parking', 'Tolls', 'VAT']) {
      expect(read.draft.dropoffText).not.toContain(word);
    }
  });

  it('leaves the price empty, because the sheet names none', () => {
    /*
     * Every charge line on this sample is blank. A sheet with no price has to
     * produce a job with no price: the system surfaces an unpriced job
     * everywhere on purpose, where a silent zero reconciles to nothing and is
     * invisible until the month comes up short.
     */
    expect(read.draft.clientPrice).toBeNull();
  });

  it('takes the trip note and leaves the standing driver rules behind', () => {
    // Everything below the note is the agency's boilerplate — how to dress,
    // how long to wait — identical on every sheet they send. Pulling it
    // through would bury the one line that is about this booking.
    expect(read.draft.notes).toContain('MUST BE FULL SIZED SUV');
    expect(read.draft.notes).not.toMatch(/Navy or Dark Grey/i);
    expect(read.draft.notes).not.toMatch(/IMPORTANT INSTRUCTIONS/i);
  });

  it('does not repeat the mobile it already has as a field', () => {
    // The sheet writes the number into the notes as well. A note that
    // duplicates a field is a note nobody reads twice.
    expect(read.draft.notes).not.toContain('615-635-7516');
  });

  it('reads nothing it was not given', () => {
    // No registration and no driver on the sheet, so none on the draft. The
    // operator assigns from the fleet, with the compliance checks that implies.
    expect(read.draft.flightNumber).toBeNull();
    expect(read.draft.luggageCount).toBeNull();
  });
});

describe('recognising the sheet', () => {
  it('refuses another agency’s paperwork', () => {
    /*
     * The failure worth protecting against. A template matched on the wrong
     * sheet reads its columns in these positions and produces a booking that
     * looks filled in and is wrong — worse than an empty form, because nobody
     * checks a form that is already full.
     */
    const other = [
      'Chauffeur Booking Confirmation',
      'Pick-up Date:        14 Oct 2026',
      'Reservation#         88123',
    ].join('\n');

    expect(montclares.matches(toLines(other))).toBe(false);
  });

  it('refuses a mention of the agency with none of the sheet', () => {
    // An email signature, a forwarded invoice, a contract.
    expect(
      montclares.matches(toLines('Thanks — Montclares International Ltd')),
    ).toBe(false);
  });

  it('says what it could not read rather than guessing', () => {
    const read = readJobSheet('Some entirely unrelated document.');

    expect(read.template).toBeNull();
    expect(read.missing).toEqual([
      'the pickup date',
      'the pickup time',
      'the pickup address',
      'the destination',
    ]);
  });
});

describe('parseSheetDate', () => {
  it('reads a month written in words', () => {
    expect(parseSheetDate('14 Oct 2026')).toBe('2026-10-14');
    expect(parseSheetDate('1 January 2027')).toBe('2027-01-01');
  });

  it('refuses an all-numeric date, rather than guessing which way round', () => {
    /*
     * `10/14/2026` and `14/10/2026` are the same characters and different
     * months, and nothing on a sheet says which side of the Atlantic typed it.
     * A booking a month out is worse than a blank field somebody fills in.
     */
    expect(parseSheetDate('10/14/2026')).toBeNull();
    expect(parseSheetDate('14/10/2026')).toBeNull();
  });

  it('refuses a day that does not exist', () => {
    // A Date constructor would roll this into March and be confidently wrong.
    expect(parseSheetDate('31 Feb 2026')).toBeNull();
    expect(parseSheetDate('32 Oct 2026')).toBeNull();
  });

  it('refuses a month it does not know', () => {
    expect(parseSheetDate('14 Xyz 2026')).toBeNull();
  });

  it('has nothing to read in nothing', () => {
    expect(parseSheetDate(null)).toBeNull();
    expect(parseSheetDate('')).toBeNull();
  });
});

describe('parseSheetTime', () => {
  it('reads a twelve-hour time', () => {
    expect(parseSheetTime('03:00 PM')).toBe('15:00');
    expect(parseSheetTime('07:45 AM')).toBe('07:45');
  });

  it('gets midnight and noon right', () => {
    /*
     * The two that catch everybody, and the arithmetic that gets one right
     * usually gets the other wrong. A pickup read as 12:00 instead of 00:00 is
     * a car twelve hours late.
     */
    expect(parseSheetTime('12:00 AM')).toBe('00:00');
    expect(parseSheetTime('12:30 AM')).toBe('00:30');
    expect(parseSheetTime('12:00 PM')).toBe('12:00');
    expect(parseSheetTime('12:15 PM')).toBe('12:15');
  });

  it('takes a twenty-four-hour time as it stands', () => {
    expect(parseSheetTime('15:00')).toBe('15:00');
    expect(parseSheetTime('07:05')).toBe('07:05');
    expect(parseSheetTime('23:59')).toBe('23:59');
  });

  it('refuses a time that is not one', () => {
    expect(parseSheetTime('13:00 PM')).toBeNull();
    expect(parseSheetTime('00:00 AM')).toBeNull();
    expect(parseSheetTime('midday')).toBeNull();
    expect(parseSheetTime(null)).toBeNull();
  });
});

describe('parseSheetMoney', () => {
  it('reads a figure the way the form wants it', () => {
    expect(parseSheetMoney('125.50')).toBe('125.50');
    expect(parseSheetMoney('£1,250.00')).toBe('1250.00');
    expect(parseSheetMoney('980')).toBe('980.00');
    expect(parseSheetMoney('12.5')).toBe('12.50');
  });

  it('treats a blank, a dash and a zero as no price at all', () => {
    // Which is this sample's case, and the one that matters: a zero that looks
    // like a price is invisible, where an unpriced job is surfaced everywhere.
    expect(parseSheetMoney(null)).toBeNull();
    expect(parseSheetMoney('')).toBeNull();
    expect(parseSheetMoney('-')).toBeNull();
    expect(parseSheetMoney('0.00')).toBeNull();
    expect(parseSheetMoney('£0')).toBeNull();
  });
});

describe('firstCell', () => {
  it('keeps the left column and drops what sits beside it', () => {
    expect(firstCell('London, SW7 2AP            Service Charge')).toBe(
      'London, SW7 2AP',
    );
  });

  it('leaves an ordinary line alone', () => {
    // An address never contains three consecutive spaces; a column break
    // always does.
    expect(firstCell('60 Upper Thames Street, London')).toBe(
      '60 Upper Thames Street, London',
    );
  });
});
