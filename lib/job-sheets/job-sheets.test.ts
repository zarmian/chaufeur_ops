import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findFlightInText, looksLikeAirport, parseFlightNumber } from './flight';
import {
  cleanNotes,
  parseSheetCount,
  parseSheetDate,
  parseSheetMoney,
  parseSheetPhone,
  parseSheetTime,
  postcodeOf,
} from './parse';
import { readJobSheet } from './read';
import { cellNear, cellsOf, firstCell, looksLikeLabel, toLines } from './types';

/**
 * Reading real agency job sheets.
 *
 * Both fixtures are the text of actual bookings as the PDFs extract, from two
 * agencies whose software agrees on nothing — not the labels, not the date
 * format, not the layout. Neither has a line of code written for it, which is
 * the point: a white-label install cannot ship a template per customer's
 * supplier.
 *
 * Every failure worth testing for here is the same failure: a field that comes
 * back confidently wrong. A wrong date puts a car out on the wrong day. A wrong
 * address sends it to the wrong building. A wrong flight number sends the
 * pickup walking off to meet a different aeroplane. An invented price turns a
 * job that should be shouting "unpriced" into one that reconciles to nothing.
 */

const fixture = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

describe('a Montclares sheet', () => {
  const read = readJobSheet(fixture('montclares-30700.txt'));

  it('reads every field a booking needs', () => {
    expect(read.missing).toEqual([]);
    expect(read.draft).toEqual({
      scheduledDate: '2026-10-14',
      // 03:00 PM, in the form's own 24-hour field.
      scheduledTime: '15:00',
      pickupText: 'The Westin London City, 60 Upper Thames Street, London, EC4V 3AD',
      pickupPostcode: 'EC4V 3AD',
      dropoffText: 'Royal Albert hall Kensington Gore, South Kensington London, SW7 2AP',
      dropoffPostcode: 'SW7 2AP',
      passengerName: 'Teresa Vaughan',
      passengerPhone: '+1 615-555-0184',
      passengerCount: '5',
      luggageCount: null,
      flightNumber: null,
      customerReference: '30700',
      clientPrice: null,
      vehicleRequested: 'V Class',
      notes:
        'MUST BE FULL SIZED SUV (usually 5 pax + luggage) unless requested otherwise. VVIP / Sr. Chauffeurs ONLY -',
      jobType: 'TRANSFER',
    });
  });

  it('reads both addresses whole, including the postcode on the wrapped line', () => {
    // The address runs onto a second line and the postcode is on it. An
    // address stopping at "60 Upper Thames Street," is one a driver cannot
    // navigate to and an operator has to retype — which is the whole point.
    expect(read.draft.pickupText).toContain('The Westin London City');
    expect(read.draft.pickupText).toContain('EC4V 3AD');
  });

  it('does not drag the charges column into the destination', () => {
    /*
     * The first bug this found. The sheet is two columns wide and the extractor
     * sees one line per row, so the second line of the destination shares its
     * row with the first charge line — and a naive read produced
     * "…SW7 2AP Service Charge Parking Tolls VAT".
     */
    for (const word of ['Service Charge', 'Parking', 'Tolls', 'VAT']) {
      expect(read.draft.dropoffText).not.toContain(word);
    }
  });

  it('does not read the field beside a label as its value', () => {
    /*
     * The second bug. `Primary Passenger:` and `Booked On:` sit on the same
     * line, so reading rightwards from the first finds the second's label and,
     * without the check, its date.
     */
    expect(read.draft.passengerName).toBe('Teresa Vaughan');
    expect(read.draft.passengerName).not.toContain('Booked On');
  });

  it('takes the mobile from the slot that is filled, not the one before it', () => {
    // The line reads `Hm: Mb: +1 615-555-0184` — home then mobile, with the
    // home number simply absent.
    expect(read.draft.passengerPhone).toBe('+1 615-555-0184');
  });

  it('leaves the price empty, because the sheet names none', () => {
    /*
     * Every charge line on this sample is blank — the rate is agreed
     * afterwards, which is the normal way these arrive. A sheet with no price
     * has to produce a job with no price: the system surfaces an unpriced job
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
    expect(read.draft.notes).not.toContain('615-555-0184');
  });

  it('finds no flight on a sheet that has none', () => {
    /*
     * The sheet carries `RM13 9XJ`, `EC4V 3AD` and `SW7 2AP` — all flight-
     * shaped once a postcode's second half is ignored — a reservation number,
     * and the words "flight landing time" in its standing instructions. Four
     * invitations to invent a flight, and a wrong one does not merely sit on
     * the job: tracking looks it up and moves the pickup.
     */
    expect(read.draft.flightNumber).toBeNull();
    expect(read.draft.jobType).toBe('TRANSFER');
  });

  it('says which label produced each value', () => {
    // Shown to the operator, and kept on the sheet so that a correction can
    // name the label that got it wrong rather than only fixing one booking.
    expect(read.sources.scheduledDate).toEqual({
      label: 'Pick-up Date:',
      placement: 'after',
    });
    expect(read.sources.pickupText?.label).toBe('PU:');
  });
});

describe('a Prestige Cars sheet', () => {
  /*
   * A second agency, and nothing about it was anticipated in code: different
   * labels, a date written "3 November 2026", a 24-hour time, a price with a
   * currency word in front of it, and a flight.
   */
  const read = readJobSheet(fixture('prestige-88214.txt'));

  it('reads a layout nothing was written for', () => {
    expect(read.missing).toEqual([]);
    expect(read.draft).toEqual({
      scheduledDate: '2026-11-03',
      scheduledTime: '07:20',
      pickupText: 'Heathrow Terminal 5, Longford, TW6 2GA',
      pickupPostcode: 'TW6 2GA',
      dropoffText: 'The Savoy, Strand, London, WC2R 0EZ',
      dropoffPostcode: 'WC2R 0EZ',
      // "Mr" dropped: the form has no title field and a name board does not
      // want one.
      passengerName: 'Alan Whitcombe',
      passengerPhone: '07700 900482',
      passengerCount: '2',
      luggageCount: '3',
      flightNumber: 'BA117',
      customerReference: 'PCL-88214',
      clientPrice: '145.00',
      vehicleRequested: null,
      notes:
        'Meet and greet in arrivals. Passenger is a wheelchair user and will need the ramp.',
      jobType: 'AIRPORT_TRANSFER',
    });
  });

  it('types it as an airport transfer, because the flight has nowhere else to go', () => {
    /*
     * Not cosmetic. The form only shows the flight number field on an airport
     * transfer, so a flight read off the sheet onto a job typed TRANSFER would
     * be dropped on the floor without a word. The wait-time allowance differs
     * too: 45 minutes free for an airport arrival against 15 otherwise.
     */
    expect(read.draft.jobType).toBe('AIRPORT_TRANSFER');
    expect(read.draft.flightNumber).toBe('BA117');
  });

  it('does not take a flight from the terms and conditions', () => {
    // "must wait 60 minutes after flight landing time" — the word is there and
    // no flight is.
    expect(read.draft.flightNumber).toBe('BA117');
    expect(read.draft.notes).not.toMatch(/dark suit/i);
  });
});

describe('what cannot be read', () => {
  it('says what is missing rather than guessing', () => {
    const read = readJobSheet('Some entirely unrelated document.');

    expect(read.draft.scheduledDate).toBeNull();
    expect(read.missing).toEqual([
      'the pickup date',
      'the pickup time',
      'the pickup address',
      'the destination',
    ]);
  });

  it('reads what it can from a half-filled sheet', () => {
    /*
     * A sheet that pre-fills four fields correctly and admits to two gaps beats
     * one that refuses because it could not find the sixth. The operator fills
     * the gaps; what they must never have to do is re-check the fields that
     * look done.
     */
    const read = readJobSheet(
      [
        'Pick-up Date:   2 December 2026',
        'Pick-up Time:   09:15',
        'Passenger Name: Dilara Koc',
      ].join('\n'),
    );

    expect(read.draft.scheduledDate).toBe('2026-12-02');
    expect(read.draft.passengerName).toBe('Dilara Koc');
    expect(read.missing).toEqual(['the pickup address', 'the destination']);
  });

  it('does not read the next labelled field as a blank box’s value', () => {
    /*
     * A column heading whose row is empty, with another field below it. The
     * value that offers itself is the agency's own booker — so the job would
     * be taken in Sarah Dean's name, go out on a name board in Sarah Dean's
     * name, and nobody would be holding it up for the passenger.
     */
    const read = readJobSheet(
      ['Passenger Name', '', 'Booked By: Sarah Dean'].join('\n'),
    );

    expect(read.draft.passengerName).toBeNull();
  });

  it('refuses the placeholders these boxes are printed with', () => {
    // A booking whose passenger is called "TBC" reaches a driver's phone and
    // then an arrivals hall, on a name board.
    const read = readJobSheet(
      ['Passenger Name:  TBC', 'Flight No:  N/A', 'Vehicle Type:  TBC'].join('\n'),
    );

    expect(read.draft.passengerName).toBeNull();
    expect(read.draft.flightNumber).toBeNull();
    expect(read.draft.vehicleRequested).toBeNull();
  });
});

describe('learning a sender’s own wording', () => {
  /*
   * The mechanism behind "it gets better as more sheets arrive". An operator
   * corrects a field once; the label that should have produced it is stored
   * against that sender; the next sheet reads it unaided. Learned labels are
   * tried before the built-in ones, because somebody looked at this sender's
   * actual paperwork to supply them.
   */
  const sheet = ['Uplift On:   8 January 2027', 'Uplift At:   22:40'].join('\n');

  it('cannot read an unusual label it has never been taught', () => {
    const read = readJobSheet(sheet);

    expect(read.draft.scheduledDate).toBeNull();
    expect(read.missing).toContain('the pickup date');
  });

  it('reads it once taught', () => {
    const read = readJobSheet(sheet, {
      learned: {
        scheduledDate: [{ label: 'Uplift On:', placement: 'after' }],
        scheduledTime: [{ label: 'Uplift At:', placement: 'after' }],
      },
    });

    expect(read.draft.scheduledDate).toBe('2027-01-08');
    expect(read.draft.scheduledTime).toBe('22:40');
    expect(read.sources.scheduledDate?.label).toBe('Uplift On:');
  });

  it('prefers what it was taught over what it assumed', () => {
    // A sender who prints two dates, where the one the built-in dictionary
    // reaches first is the wrong one.
    const two = [
      'Booking Date:   1 March 2027',
      'Pick-up Date:   4 March 2027',
    ].join('\n');

    expect(readJobSheet(two).draft.scheduledDate).toBe('2027-03-04');
    expect(
      readJobSheet(two, {
        learned: { scheduledDate: [{ label: 'Booking Date:', placement: 'after' }] },
      }).draft.scheduledDate,
    ).toBe('2027-03-01');
  });
});

describe('parseFlightNumber', () => {
  it('reads the forms airlines actually use', () => {
    expect(parseFlightNumber('BA117')).toBe('BA117');
    expect(parseFlightNumber('ba 117')).toBe('BA117');
    expect(parseFlightNumber('U28342')).toBe('U28342');
    expect(parseFlightNumber('4U 755')).toBe('4U755');
    expect(parseFlightNumber('EZY2203')).toBe('EZY2203');
    expect(parseFlightNumber('LH900A')).toBe('LH900A');
  });

  it('takes the code and leaves the commentary', () => {
    expect(parseFlightNumber('BA117 lands 14:35')).toBe('BA117');
  });

  it('refuses a postcode', () => {
    /*
     * The whole difficulty of this field. A British postcode's outward code is
     * exactly the shape of an airline designator and a number.
     */
    expect(parseFlightNumber('EC4V 3AD')).toBeNull();
    expect(parseFlightNumber('RM13 9XJ')).toBeNull();
    expect(parseFlightNumber('SW7 2AP')).toBeNull();
  });

  it('refuses a reference, a word and a placeholder', () => {
    expect(parseFlightNumber('30700')).toBeNull();
    expect(parseFlightNumber('TBC')).toBeNull();
    expect(parseFlightNumber('N/A')).toBeNull();
    expect(parseFlightNumber('-')).toBeNull();
    expect(parseFlightNumber('British Airways')).toBeNull();
    expect(parseFlightNumber(null)).toBeNull();
  });
});

describe('findFlightInText', () => {
  it('finds a flight the sheet only mentions in prose', () => {
    // Where it lives on a sheet with no flight box, which is most of them.
    expect(findFlightInText('Passenger arriving on flight BA117, meet airside.')).toBe(
      'BA117',
    );
    expect(findFlightInText('Flight No: EZY2203')).toBe('EZY2203');
    expect(findFlightInText('BA117 arriving T5')).toBe('BA117');
  });

  it('finds nothing in an agency’s standing instructions', () => {
    /*
     * The sentence that made this a labelled-only search. It contains the word
     * and no flight, and it is on every sheet this agency sends.
     */
    expect(
      findFlightInText(
        'For ALL airport pick ups drivers must be on location at flight landing time.',
      ),
    ).toBeNull();
    expect(
      findFlightInText('Drivers must wait 60 minutes after flight landing time.'),
    ).toBeNull();
  });

  it('does not take a postcode that happens to sit near the word', () => {
    expect(
      findFlightInText('Collect from 125 Lambs Ln S Rainham, RM13 9XJ for the flight'),
    ).toBeNull();
  });
});

describe('looksLikeAirport', () => {
  it('knows the ones a London operator meets', () => {
    expect(looksLikeAirport('Heathrow Terminal 5, Longford')).toBe(true);
    expect(looksLikeAirport('London City Airport')).toBe(true);
    expect(looksLikeAirport('Farnborough')).toBe(true);
    expect(looksLikeAirport('LGW')).toBe(true);
  });

  it('does not see one in an ordinary address', () => {
    // The free wait-time allowance is three times longer at an airport, so a
    // false positive gives away half an hour on every job.
    expect(looksLikeAirport('The Savoy, Strand, London')).toBe(false);
    expect(looksLikeAirport('60 Upper Thames Street, London, EC4V 3AD')).toBe(false);
    expect(looksLikeAirport(null)).toBe(false);
  });
});

describe('the job type a sheet implies', () => {
  const typeOf = (text: string) => readJobSheet(text).draft.jobType;

  it('is an airport transfer when either end is an airport', () => {
    expect(
      typeOf('PU: Gatwick South Terminal\nDO: The Dorchester, Park Lane'),
    ).toBe('AIRPORT_TRANSFER');
    expect(
      typeOf('PU: The Dorchester, Park Lane\nDO: Heathrow Terminal 2'),
    ).toBe('AIRPORT_TRANSFER');
  });

  it('is an airport transfer on a flight alone, wherever the car goes', () => {
    /*
     * A private-jet terminal is not called an airport — "Signature, Western
     * Perimeter Road" — so the address test misses it and only the flight says
     * what this job is. It has to be enough on its own: the form hides the
     * flight number field on anything but an airport transfer, so typing this
     * as a plain transfer would read BA117 off the sheet and then drop it
     * without a word.
     */
    const read = readJobSheet(
      [
        'Pick-up Date:  4 March 2027',
        'Pick-up Time:  09:00',
        'Flight No:     BA117',
        'PU: Signature, Western Perimeter Road',
        'DO: The Savoy, Strand',
      ].join('\n'),
    );

    expect(read.draft.flightNumber).toBe('BA117');
    expect(read.draft.jobType).toBe('AIRPORT_TRANSFER');
  });

  it('is hourly hire when the sheet says so', () => {
    expect(
      typeOf('PU: The Dorchester\nDO: As directed\nNotes: 4 hours as directed'),
    ).toBe('AS_DIRECTED');
  });

  it('prefers the airport when a job is both', () => {
    // "As directed from Heathrow" is an airport pickup that then runs on, and
    // the allowance it needs is the airport one.
    expect(
      typeOf('PU: Heathrow Terminal 3\nDO: As directed\nNotes: as directed after'),
    ).toBe('AIRPORT_TRANSFER');
  });

  it('is a plain transfer otherwise', () => {
    expect(typeOf('PU: The Savoy, Strand\nDO: 10 Downing Street')).toBe('TRANSFER');
  });
});

describe('parseSheetDate', () => {
  it('reads a month written in words, either order', () => {
    expect(parseSheetDate('14 Oct 2026')).toBe('2026-10-14');
    expect(parseSheetDate('1 January 2027')).toBe('2027-01-01');
    expect(parseSheetDate('3rd November 2026')).toBe('2026-11-03');
    // What US-configured booking software prints.
    expect(parseSheetDate('Oct 14, 2026')).toBe('2026-10-14');
  });

  it('refuses an all-numeric date, rather than guessing which way round', () => {
    /*
     * `10/14/2026` and `14/10/2026` are the same characters and different
     * months, and nothing on a sheet says which side of the Atlantic typed it.
     * A booking a month out is worse than a blank field somebody fills in.
     */
    expect(parseSheetDate('10/14/2026')).toBeNull();
    expect(parseSheetDate('14/10/2026')).toBeNull();
    expect(parseSheetDate('2026-10-14')).toBeNull();
  });

  it('refuses a day that does not exist', () => {
    // A Date constructor would roll this into March and be confidently wrong.
    expect(parseSheetDate('31 Feb 2026')).toBeNull();
    expect(parseSheetDate('32 Oct 2026')).toBeNull();
  });

  it('refuses a month it does not know, and nothing at all', () => {
    expect(parseSheetDate('14 Xyz 2026')).toBeNull();
    expect(parseSheetDate(null)).toBeNull();
    expect(parseSheetDate('')).toBeNull();
  });
});

describe('parseSheetTime', () => {
  it('reads a twelve-hour time', () => {
    expect(parseSheetTime('03:00 PM')).toBe('15:00');
    expect(parseSheetTime('07:45 AM')).toBe('07:45');
    expect(parseSheetTime('7.45 a.m.')).toBe('07:45');
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
    expect(parseSheetMoney('GBP 145.00')).toBe('145.00');
    expect(parseSheetMoney('980')).toBe('980.00');
    expect(parseSheetMoney('12.5')).toBe('12.50');
  });

  it('treats a blank, a dash and a zero as no price at all', () => {
    // A zero that looks like a price is invisible, where an unpriced job is
    // surfaced everywhere.
    expect(parseSheetMoney(null)).toBeNull();
    expect(parseSheetMoney('')).toBeNull();
    expect(parseSheetMoney('-')).toBeNull();
    expect(parseSheetMoney('0.00')).toBeNull();
    expect(parseSheetMoney('£0')).toBeNull();
  });
});

describe('the smaller parsers', () => {
  it('reads a count, and refuses a zero', () => {
    expect(parseSheetCount('5')).toBe('5');
    expect(parseSheetCount('2 adults')).toBe('2');
    expect(parseSheetCount('0')).toBeNull();
    expect(parseSheetCount('V Class')).toBeNull();
  });

  it('reads a phone number but not a reference', () => {
    expect(parseSheetPhone('07700 900482')).toBe('07700 900482');
    expect(parseSheetPhone('+1 615-555-0184')).toBe('+1 615-555-0184');
    // Short enough to be a job number with punctuation in it.
    expect(parseSheetPhone('30700')).toBeNull();
    expect(parseSheetPhone('n/a')).toBeNull();
  });

  it('finds the postcode at the end of an address, not one inside it', () => {
    expect(postcodeOf('The Savoy, Strand, London, WC2R 0EZ')).toBe('WC2R 0EZ');
    expect(postcodeOf('Studio W1, 2 Bank Street, London, E14 4AD')).toBe('E14 4AD');
    expect(postcodeOf('The Dorchester, Park Lane')).toBeNull();
  });

  it('drops a phone number a note merely repeats', () => {
    expect(cleanNotes('cell: 615-555-0184 MUST BE FULL SIZED SUV')).toBe(
      'MUST BE FULL SIZED SUV',
    );
    expect(cleanNotes('   ')).toBeNull();
  });
});

describe('cells', () => {
  it('splits a line where the page has a column break', () => {
    // A run of three or more spaces. An address never contains one; every one
    // of these layouts pads with many more.
    const [line] = toLines('London, SW7 2AP            Service Charge');
    expect(cellsOf(line!).map((cell) => cell.text)).toEqual([
      'London, SW7 2AP',
      'Service Charge',
    ]);
  });

  it('leaves an ordinary line whole', () => {
    expect(firstCell('60 Upper Thames Street, London')).toBe(
      '60 Upper Thames Street, London',
    );
  });

  it('takes the cell in the column asked for, or none', () => {
    const [line] = toLines('London, SW7 2AP                      Service Charge');
    expect(cellNear(line!, 0)).toBe('London, SW7 2AP');
    // Nothing near the far column, so a wrapped address stops rather than
    // swallowing what is printed beside it.
    expect(cellNear(line!, 200)).toBeNull();
  });

  it('knows a label from a value', () => {
    expect(looksLikeLabel('Booked On:')).toBe(true);
    expect(looksLikeLabel('Reservation#')).toBe(true);
    expect(looksLikeLabel('Teresa Vaughan')).toBe(false);
    expect(looksLikeLabel('14 Oct 2026')).toBe(false);
  });
});
